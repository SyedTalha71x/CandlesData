import { Socket } from "net";
import pkg from "pg";
const { Pool } = pkg;
import Bull from "bull";
import { configDotenv } from "dotenv";
import { createClient } from "redis";
import { v4 as uuidv4 } from 'uuid';

configDotenv();


const FIX_SERVER = process.env.FIX_SERVER;
const FIX_PORT = process.env.FIX_PORT;
const SENDER_COMP_ID = process.env.SENDER_COMP_ID;
const TARGET_COMP_ID = process.env.TARGET_COMP_ID;
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

const PG_HOST = process.env.PG_HOST;
const PG_PORT = process.env.PG_PORT;
const PG_USER = process.env.PG_USER;
const PG_PASSWORD = process.env.PG_PASSWORD;
const PG_DATABASE = process.env.PG_DATABASE;

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379");

if (
  !FIX_SERVER ||
  !FIX_PORT ||
  !SENDER_COMP_ID ||
  !TARGET_COMP_ID ||
  !USERNAME ||
  !PASSWORD
) {
  console.log(
    "One or more required environment variables are missing, using sample mode."
  );
}

const redisClient = createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`
});

redisClient.on('error', (err) => {
  console.error('Redis error:', err);
});

redisClient.connect().then(() => {
  console.log('Connected to Redis');
}).catch((err) => {
  console.error('Failed to connect to Redis:', err);
});

const timeFrames = {
  M1: 60000, 
  H1: 3600000,
  D1: 86400000, 
};

let sequenceNumber = 0;
let isConnected = false;
let reconnectTimeout: NodeJS.Timeout | null = null;

interface MarketDataMessage {
  symbol: string;
  type: "BID" | "ASK";
  price: number;
  quantity: number;
  timestamp: string;
  rawData: Record<string, string>;
}

interface TickData {
  symbol: string;
  price: number;
  timestamp: Date;
  lots: number;
}


const marketDataQueue = new Bull("marketData", {
  redis: {
    host: REDIS_HOST,
    port: REDIS_PORT,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: true,
    timeout: 30000, // Increase job timeout to 30 seconds
  },
  limiter: {
    max: 100, // Max jobs processed per second
    duration: 1000,
  },
  settings: {
    maxStalledCount: 1, // Prevent jobs from being marked as stalled too quickly
  },
});
const candleProcessingQueue = new Bull("candleProcessing", {
  redis: {
    host: REDIS_HOST,
    port: REDIS_PORT,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: true,
    timeout: 30000,
  },
  limiter: {
    max: 50, // Lower limit for candle processing as it's more resource-intensive
    duration: 1000,
  },
});
const MESSAGE_TYPES: Record<string, string> = {
  "0": "Heartbeat",
  "1": "Test Request",
  "2": "Resend Request",
  "3": "Reject",
  "4": "Sequence Reset",
  "5": "Logout",
  A: "Logon",
  V: "Market Data Request",
  W: "Market Data Snapshot",
  X: "Market Data Incremental Refresh",
};
const MD_ENTRY_TYPES: Record<string, string> = {
  "0": "BID",
  "1": "ASK",
  "2": "TRADE",
  "3": "INDEX_VALUE",
  "4": "OPENING_PRICE",
  "5": "CLOSING_PRICE",
  "6": "SETTLEMENT_PRICE",
  "7": "TRADING_SESSION_HIGH_PRICE",
  "8": "TRADING_SESSION_LOW_PRICE",
};

interface ParsedFixMessage {
  messageType: string;
  senderCompId: string;
  targetCompId: string;
  msgSeqNum: number;
  sendingTime: string;
  rawMessage: string;
  testReqId?: string;
  username?: string;
  additionalFields: Record<string, string>;
}

const pgPool = new Pool({
  host: PG_HOST,
  port: PG_PORT ? Number(PG_PORT) : 5432,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
});

interface CurrencyPairInfo {
  currpair: string;
  contractsize: number | null;
}

// Store subscribable currency pairs
let availableCurrencyPairs: CurrencyPairInfo[] = [];

// Track subscribed currency pairs
const subscribedPairs: Set<string> = new Set();

export const ensureCandleTableExists = async (
  tableName: string
): Promise<void> => {
  try {
    const tableCheck = await pgPool.query(
      `
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = $1
        )
        `,
      [tableName]
    );

    if (!tableCheck.rows[0].exists) {
      console.log(`Table ${tableName} does not exist, creating it...`);

      await pgPool.query(`
          CREATE TABLE ${tableName} (
              candlesize TEXT NOT NULL,
              lots SMALLINT NOT NULL,
              candletime TIMESTAMP WITH TIME ZONE NOT NULL,
              open NUMERIC(12,5) NOT NULL,
              high NUMERIC(12,5) NOT NULL,
              low NUMERIC(12,5) NOT NULL,
              close NUMERIC(12,5) NOT NULL,
              PRIMARY KEY (candlesize, lots, candletime)
          )
        `);

      console.log(`Created candle table ${tableName}`);
    }
  } catch (error) {
    console.error(`Error ensuring candle table ${tableName} exists:`, error);
    throw error;
  }
};


const initCandleTables = async () => {
  try {
    const result = await pgPool.query("SELECT currpair FROM currpairdetails");
    const allCurrencyPairs = result.rows;

    for (const pair of allCurrencyPairs) {
      const tableName = `candles_${pair.currpair.toLowerCase()}_bid`;
      await ensureCandleTableExists(tableName);
    }
  } catch (error) {
    console.error("Error initializing candle tables:", error);
  }
};

const processTickForCandles = async (tickData: TickData) => {
  try {
    // Add to candle processing queue
    await candleProcessingQueue.add(
      {
        tickData,
        timeFrames: Object.keys(timeFrames),
      },
      {
        jobId: `candle_${tickData.symbol}_${Date.now()}`,
      }
    );

  } catch (error) {
    console.error("Error adding tick to candle processing queue:", error);
  }
};

const initDatabase = async () => {
  try {
    await fetchAllCurrencyPairs();
    await initCandleTables();


    await cacheCandlesAndTicks();
  } catch (error) {
    console.error("Error initializing database tables:", error);
  }
};

const fetchAllCurrencyPairs = async () => {
  try {
    const result = await pgPool.query(
      "SELECT currpair, contractsize FROM currpairdetails"
    );
    availableCurrencyPairs = result.rows;

    const validPairs = availableCurrencyPairs.filter(
      (pair) => pair.contractsize !== null
    );
    const invalidPairs = availableCurrencyPairs.filter(
      (pair) => pair.contractsize === null
    );

    if (invalidPairs.length > 0) {
      console.log(
        "Skipping subscription for the following pairs due to null contract size:"
      );
      invalidPairs.forEach((pair) => console.log(`- ${pair.currpair}`));
    }

    // Add valid pairs to subscribed set
    validPairs.forEach((pair) => {
      subscribedPairs.add(pair.currpair);
    });


    for (const pair of validPairs) {
      await ensureTableExists(
        `ticks_${pair.currpair.toLowerCase()}_bid`,
        "BID"
      );
      await ensureTableExists(
        `ticks_${pair.currpair.toLowerCase()}_ask`,
        "ASK"
      );
    }
  } catch (error) {
    console.error("Error fetching currency pairs:", error);
  }
};

const getUTCTimestamp = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getUTCDate()).padStart(2, "0")}-${String(
    now.getUTCHours()
  ).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(
    now.getUTCSeconds()
  ).padStart(2, "0")}.${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
};

const calculateChecksum = (message: string): string => {
  let sum = 0;
  for (let i = 0; i < message.length; i++) {
    sum += message.charCodeAt(i);
  }
  return (sum % 256).toString().padStart(3, "0");
};

const createFixMessage = (
  body: Record<number | string, string | number>
): string => {
  sequenceNumber += 1;

  const messageBody = [
    `35=${body[35]}`,
    `49=${SENDER_COMP_ID}`,
    `56=${TARGET_COMP_ID}`,
    `34=${sequenceNumber}`,
    `52=${getUTCTimestamp()}`,
    ...Object.entries(body)
      .filter(([key]) => !["35"].includes(key))
      .map(([key, value]) => `${key}=${value}`),
  ].join("\u0001");

  const bodyLength = messageBody.length;
  let fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`;
  const checksum = calculateChecksum(fullMessage + "\u0001");
  return `${fullMessage}\u000110=${checksum}\u0001`;
};

const ensureTableExists = async (
  tableName: string,
  type: "BID" | "ASK"
): Promise<void> => {
  try {
    const tableCheck = await pgPool.query(
      `
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = $1
            )
        `,
      [tableName]
    );

    if (!tableCheck.rows[0].exists) {

      await pgPool.query(`
                CREATE TABLE ${tableName} (
                    ticktime TIMESTAMP WITH TIME ZONE NOT NULL,
                    lots INTEGER PRIMARY KEY,
                    price NUMERIC NOT NULL
                )
            `);

    }
  } catch (error) {
    console.error(`Error ensuring table ${tableName} exists:`, error);
    throw error;
  }
};

const cacheCandlesAndTicks = async () => {
  try {
    const result = await pgPool.query("SELECT currpair FROM currpairdetails");
    const allCurrencyPairs = result.rows;

    for (const pair of allCurrencyPairs) {
      const symbol = pair.currpair.toLowerCase();
      const bidTableName = `ticks_${symbol}_bid`;
      const askTableName = `ticks_${symbol}_ask`;
      const candleTableName = `candles_${symbol}_bid`;

      const bidTicks = await pgPool.query(`SELECT * FROM ${bidTableName}`);
      const askTicks = await pgPool.query(`SELECT * FROM ${askTableName}`);

      await redisClient.set(`ticks_${symbol}_bid`, JSON.stringify(bidTicks.rows));
      await redisClient.set(`ticks_${symbol}_ask`, JSON.stringify(askTicks.rows));

      const candles = await pgPool.query(`SELECT * FROM ${candleTableName}`);
      await redisClient.set(`candles_${symbol}`, JSON.stringify(candles.rows));

      console.log(`Cached data for ${symbol}`);
    }
  } catch (error) {
    console.error("Error caching data:", error);
  }
};

marketDataQueue.process(5, async (job) => {
  try {
    const data: MarketDataMessage = job.data;
    console.log(`Processing market data job for ${data.symbol} (${data.type})`);

    const contractSize = await getContractSize(data.symbol);
    console.log(`Got contract size: ${contractSize} for ${data.symbol}`);

    const lots = calculateLots(data.quantity, contractSize);

    // Format time from data.timestamp
    let ticktime = new Date();
    if (data.rawData["273"]) {
      const timeStr = data.rawData["273"];
      const [hours, minutes, seconds] = timeStr.split(":").map(Number);
      ticktime = new Date();
      ticktime.setHours(hours, minutes, seconds);
    }


    // Determine which table to use based on the type
    let tableName: string;
    const symbolLower = data.symbol.toLowerCase();

    if (data.type === "BID") {
      tableName = `ticks_${symbolLower}_bid`;
    } else {
      tableName = `ticks_${symbolLower}_ask`;
    }

    await ensureTableExists(tableName, data.type);

    const tickData = {
      ticktime: ticktime.toISOString(),
      lots: lots,
      price: data.price,
    };

    await redisClient.rPush(`ticks_${symbolLower}_${data.type.toLowerCase()}`, JSON.stringify(tickData));

    const query = {
      text: `
                INSERT INTO ${tableName} 
                (ticktime, lots, price)
                VALUES ($1, $2, $3)
                ON CONFLICT (lots) DO NOTHING;
            `,
      values: [ticktime.toISOString(), lots, data.price],
    };

    await pgPool.query(query);
    if (data.type === "BID") {
      await processTickForCandles({
        symbol: data.symbol,
        price: data.price,
        timestamp: ticktime,
        lots: lots,
      });
    }

    return { success: true, symbol: data.symbol, type: data.type };
  } catch (error) {
    console.error(`Error processing market data job:`, error);
    throw error;
  }
});
candleProcessingQueue.process(async (job) => {
  const { tickData, timeFrames } = job.data;
  const { symbol, price } = tickData;

  const lots = 1;

  const timestamp = new Date(tickData.timestamp);

  if (isNaN(timestamp.getTime())) {
    console.error(`Invalid timestamp for ${symbol}: ${tickData.timestamp}`);
    throw new Error(`Invalid timestamp for ${symbol}`);
  }

  const defaultTimeFrames = {
    M1: 60000,    
    H1: 3600000,  
    D1: 86400000,
  };

  // Ensure timeFrames is an object with valid values
  const resolvedTimeFrames = typeof timeFrames === 'object' && !Array.isArray(timeFrames)
    ? timeFrames
    : defaultTimeFrames;

  // For each timeframe (M1, H1, D1)
  for (const timeframe of Object.keys(resolvedTimeFrames)) {
    try {
      const timeframeDuration = resolvedTimeFrames[timeframe];

      // Ensure the timeframe duration is valid
      if (typeof timeframeDuration !== 'number' || isNaN(timeframeDuration)) {
        console.error(`Invalid duration for timeframe ${timeframe}:`, timeframeDuration);
        continue;
      }

      // Calculate the candle time (start time of the candle)
      const candleTimeMs =
        Math.floor(timestamp.getTime() / timeframeDuration) *
        timeframeDuration;

      const candleTime = new Date(candleTimeMs);

      if (isNaN(candleTime.getTime())) {
        console.error(`Invalid candleTime for ${symbol} and timeframe ${timeframe}`);
        continue;
      }


      const tableName = `candles_${symbol.toLowerCase()}_bid`;

      const redisCandle = await redisClient.get(`candle_${symbol}_${timeframe}_${candleTime.toISOString()}`);

      if (redisCandle) {
        const currentCandle = JSON.parse(redisCandle);

        const updatedCandle = {
          ...currentCandle,
          high: Math.max(currentCandle.high, price),
          low: Math.min(currentCandle.low, price),
          close: price,
        };

        await redisClient.set(`candle_${symbol}_${timeframe}_${candleTime.toISOString()}`, JSON.stringify(updatedCandle));

        console.log(`Updated ${timeframe} candle for ${symbol} in Redis`);
      } else {
        const newCandle = {
          candlesize: timeframe,
          lots: lots,
          candletime: candleTime.toISOString(),
          open: price,
          high: price,
          low: price,
          close: price,
        };

        await redisClient.set(`candle_${symbol}_${timeframe}_${candleTime.toISOString()}`, JSON.stringify(newCandle));

        console.log(`Created new ${timeframe} candle for ${symbol} in Redis`);
      }


      const existingCandleQuery = {
        text: `
          SELECT * FROM ${tableName}
          WHERE candlesize = $1
          AND lots = $2
          AND candletime = $3
        `,
        values: [timeframe, lots, candleTime.toISOString()],
      };

      const existingCandle = await pgPool.query(existingCandleQuery);

      if (existingCandle.rows.length > 0) {
        // Update existing candle
        const currentCandle = existingCandle.rows[0];

        const updateQuery = {
          text: `
            UPDATE ${tableName}
            SET high = GREATEST(high, $1),
                low = LEAST(low, $2),
                close = $3
            WHERE candlesize = $4
            AND lots = $5
            AND candletime = $6
          `,
          values: [
            price,
            price,
            price,
            timeframe,
            lots,
            candleTime.toISOString(),
          ],
        };

        await pgPool.query(updateQuery);
      } else {
        const insertQuery = {
          text: `
            INSERT INTO ${tableName}
            (candlesize, lots, candletime, open, high, low, close)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          values: [
            timeframe,
            lots,
            candleTime.toISOString(),
            price, // open
            price, // high (same as open for new candle)
            price, // low (same as open for new candle)
            price, // close (same as open for new candle)
          ],
        };

        await pgPool.query(insertQuery);
      }
    } catch (error) {
      console.error(
        `Error processing ${timeframe} candle for ${symbol}:`,
        error
      );
      throw error;
    }
  }

  return { success: true, symbol };
});

marketDataQueue.on("completed", (job, result) => {
  console.log(`Job ${job.id} completed: ${result.symbol} ${result.type}`);
});

marketDataQueue.on("failed", (job, error) => {
  console.error(` Job ${job.id} failed:`, error);
});

candleProcessingQueue.on("completed", (job, result) => {
  console.log(`job ${job.id} completed: ${result.symbol}`);
});

candleProcessingQueue.on("failed", (job, error) => {
  console.error(` Job ${job.id} failed:`, error);
});

const getContractSize = async (symbol: string): Promise<number> => {
  try {
    const pairInfo = availableCurrencyPairs.find(
      (pair) => pair.currpair === symbol
    );

    if (pairInfo && pairInfo.contractsize !== null) {
      return parseFloat(pairInfo.contractsize.toString());
    } else {


      // Try to get the contract size directly from the database as a fallback
      try {
        const result = await pgPool.query(
          "SELECT contractsize FROM currpairdetails WHERE currpair = $1",
          [symbol]
        );

        if (result.rows.length > 0 && result.rows[0].contractsize !== null) {

          return parseFloat(result.rows[0].contractsize.toString());
        }
      } catch (dbError) {
        console.error(`Database lookup for contract size failed:`, dbError);
      }

      throw new Error(
        `Cannot process data for ${symbol}: No valid contract size found`
      );
    }
  } catch (error) {
    console.error(`Error getting contract size for ${symbol}:`, error);
    throw new Error(`Cannot process market data: ${error.message}`);
  }
};

const calculateLots = (quantity: number, contractSize: number): number => {

  return Math.round(quantity / contractSize);
};

class FixClient {
  private client!: Socket;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 1000;
  private readonly reconnectDelay: number = 5000;
  private buffer: string = "";

  constructor() {
    this.initializeClient();
    // Initialize database
    initDatabase().catch((err) => {
      console.error("Failed to initialize database:", err);
    });
  }

  private initializeClient() {
    this.client = new Socket();
    this.client.setKeepAlive(true, 30000);
    this.client.setNoDelay(true);
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.on("connect", this.handleConnect.bind(this));
    this.client.on("data", this.handleData.bind(this));
    this.client.on("error", this.handleError.bind(this));
    this.client.on("close", this.handleClose.bind(this));
    this.client.on("end", this.handleEnd.bind(this));
  }

  private parseFixMessage(message: string): ParsedFixMessage {
    const fields = message.split("\u0001");
    const fieldMap: Record<string, string> = {};

    // Parse all fields into key-value pairs
    fields.forEach((field) => {
      const [key, value] = field.split("=");
      if (key && value) {
        fieldMap[key] = value;
      }
    });

    // Extract common fields
    const messageType = fieldMap["35"];
    const readableType =
      MESSAGE_TYPES[messageType] || `Unknown (${messageType})`;

    const parsed: ParsedFixMessage = {
      messageType: readableType,
      senderCompId: fieldMap["49"] || "",
      targetCompId: fieldMap["56"] || "",
      msgSeqNum: parseInt(fieldMap["34"] || "0"),
      sendingTime: fieldMap["52"] || "",
      rawMessage: message,
      additionalFields: {},
    };

    // Add optional fields if present
    if (fieldMap["112"]) parsed.testReqId = fieldMap["112"];
    if (fieldMap["553"]) parsed.username = fieldMap["553"];

    // Add any other fields to additionalFields
    Object.entries(fieldMap).forEach(([key, value]) => {
      if (
        !["8", "9", "35", "49", "56", "34", "52", "10", "112", "553"].includes(
          key
        )
      ) {
        parsed.additionalFields[key] = value;
      }
    });

    return parsed;
  }

  private logParsedMessage(
    parsed: ParsedFixMessage,
    direction: "Sent" | "Received"
  ) {
    const timestamp = new Date().toISOString();
    console.log("\n" + "=".repeat(80));
    console.log(`${direction} at ${timestamp}`);
    console.log("-".repeat(80));
    console.log(`Message Type: ${parsed.messageType}`);
    console.log(`From: ${parsed.senderCompId}`);
    console.log(`To: ${parsed.targetCompId}`);
    console.log(`Sequence: ${parsed.msgSeqNum}`);
    console.log(`Time: ${parsed.sendingTime}`);

    if (parsed.testReqId) {
      console.log(`Test Request ID: ${parsed.testReqId}`);
    }

    if (Object.keys(parsed.additionalFields).length > 0) {
      console.log("\nAdditional Fields:");
      Object.entries(parsed.additionalFields).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
    }
    console.log("=".repeat(80) + "\n");
  }


  private resetSequenceNumber() {
    sequenceNumber = 0;
    console.log("Reset sequence number to 0");
  }

  private handleConnect() {
    console.log("Connected to FIX server");
    isConnected = true;
    this.reconnectAttempts = 0;
    this.buffer = "";
  
      console.log("Redis cache cleared on reconnect");
      
      const logonMessage = createFixMessage({
        35: "A",
        98: 0,
        108: 30,
        553: USERNAME || "",
        554: PASSWORD || "",
        141: "Y",
      });
  
      this.client.write(logonMessage);
      const parsed = this.parseFixMessage(logonMessage);
      console.log("Logon sent");
      this.logParsedMessage(parsed, "Sent");
  }

  private handleData(data: Buffer) {
    // Append the new data to our buffer
    this.buffer += data.toString();

    // Process any complete FIX messages in the buffer
    const messages = this.extractMessages();

    for (const message of messages) {
      // console.log("RAW MESSAGE RECEIVED:", message);

      const parsed = this.parseFixMessage(message);
      this.logParsedMessage(parsed, "Received");

      // Process market data messages
      if (
        parsed.messageType === "Market Data Snapshot" ||
        parsed.messageType === "Market Data Incremental Refresh"
      ) {
        console.log("Received market data response!");

        try {
          // Extract market data entries
          const noMDEntries = parseInt(parsed.additionalFields["268"] || "0");
          const symbol = parsed.additionalFields["55"] || "";

          // console.log(
          //   `Got market data for symbol: ${symbol}, entries: ${noMDEntries}`
          // );

          if (noMDEntries > 0 && symbol) {
            // Process all incoming data regardless of subscription status
            // console.log(
            //   `Processing ${noMDEntries} market data entries for ${symbol}`
            // );

            // Extract all fields directly from the raw message
            const rawFields = message.split("\u0001");
            const fieldMap: Record<string, string> = {};

            rawFields.forEach((field) => {
              const [tag, value] = field.split("=");
              if (tag && value) {
                fieldMap[tag] = value;
              }
            });

            // Find all repeating group entries in the original message
            const mdEntries: Array<Record<string, string>> = [];
            let currentEntry: Record<string, string> = {};
            let inEntry = false;

            // Process the fields in order
            for (const field of rawFields) {
              const [tag, value] = field.split("=");
              if (!tag || !value) continue;

              // Check if this is the beginning of a new entry (MDEntryType)
              if (tag === "269") {
                if (inEntry && Object.keys(currentEntry).length > 0) {
                  // Save the previous entry
                  mdEntries.push(currentEntry);
                }
                // Start a new entry
                currentEntry = {};
                inEntry = true;
              }

              // If we're in an entry, collect its fields
              if (inEntry) {
                if (["269", "270", "271", "273"].includes(tag)) {
                  currentEntry[tag] = value;
                }
              }
            }

            // Add the last entry if it exists
            if (inEntry && Object.keys(currentEntry).length > 0) {
              mdEntries.push(currentEntry);
            }

            // console.log(`Extracted ${mdEntries.length} market data entries`);

            // Process each entry
            for (let i = 0; i < mdEntries.length; i++) {
              const entry = mdEntries[i];
              // console.log(
              //   `Entry ${i + 1} - Type: ${entry["269"]}, Price: ${entry["270"]
              //   }, Size: ${entry["271"]}`
              // );

              if (entry["269"] && entry["270"]) {
                const entryType = entry["269"];
                const price = parseFloat(entry["270"]);
                const size = parseFloat(entry["271"] || "0");
                const time = entry["273"] || "";

                if (["0", "1"].includes(entryType)) {
                  // BID or ASK
                  const type = MD_ENTRY_TYPES[entryType];

                  // console.log(
                  //   `Found ${type} entry for ${symbol}: Price=${price}, Size=${size}`
                  // );

                  // Create market data message and add to queue
                  const marketData: MarketDataMessage = {
                    symbol,
                    type: type as "BID" | "ASK",
                    price,
                    quantity: size,
                    timestamp: new Date().toISOString(),
                    rawData: {
                      "55": symbol,
                      "262": parsed.additionalFields["262"] || "",
                      "268": parsed.additionalFields["268"] || "",
                      "269": entryType,
                      "270": price.toString(),
                      "271": size.toString(),
                      "273": time,
                    },
                  };

                  // console.log(`Adding to queue: ${JSON.stringify(marketData)}`);
                  marketDataQueue.add(marketData, {
                    jobId: `${symbol}_${type}_${Date.now()}`,
                  });

                  // console.log(
                  //   `Added ${type} data for ${symbol} to queue: ${price}`
                  // );
                }
              }
            }
          } else {
            console.log(
              `No market data entries found for ${symbol || "unknown symbol"}`
            );
          }
        } catch (error) {
          console.error("Error processing market data:", error);
        }
      } else if (parsed.messageType === "Reject") {
        console.error(
          "Request rejected by server:",
          parsed.additionalFields["58"] || "Unknown reason"
        );
      } else if (parsed.messageType === "Logon") {
        console.log("Logon response received, authentication successful");
        // Subscribe after successful logon with a small delay
        setTimeout(() => {
          this.subscribeToMarketData();
        }, 1000);
      } else if (parsed.messageType === "Heartbeat") {
        console.log("Received heartbeat from server");
      } else {
        console.log(`Received message of type: ${parsed.messageType}`);
      }
    }
  }

  // Extract complete FIX messages from the buffer
  private extractMessages(): string[] {
    const messages: string[] = [];
    const delimiter = "\u000110=";
    let position = 0;

    while (true) {
      const start = this.buffer.indexOf("8=FIX", position);
      if (start === -1) break;

      const end = this.buffer.indexOf(delimiter, start);
      if (end === -1) break;

      // Find the end of the checksum (3 more characters after the delimiter)
      const checksumEnd = end + delimiter.length + 3;
      if (checksumEnd > this.buffer.length) break;

      // Extract the complete message including the checksum
      const message = this.buffer.substring(start, checksumEnd + 1);
      messages.push(message);

      // Move position past this message
      position = checksumEnd + 1;
    }

    // Remove processed messages from the buffer
    if (position > 0) {
      this.buffer = this.buffer.substring(position);
    }

    return messages;
  }

  private handleError(err: Error) {
    console.log("Socket error:", err.message);
    if (isConnected) {
      isConnected = false;
    }

    this.reconnect();
  }

  private handleClose(hadError: boolean) {
    console.log("Connection closed", hadError ? "due to error" : "normally");
    isConnected = false;
    this.reconnect();
  }

  private handleEnd() {
    console.log("Connection ended");
    isConnected = false;
    this.reconnect();
  }

  private reconnect() {
    if (reconnectTimeout !== null) {
      clearTimeout(reconnectTimeout);
    }
  
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`
      );
  
      this.client.removeAllListeners();
      this.client.destroy();
  
      this.initializeClient();
  
      reconnectTimeout = setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
  
      redisClient.connect().then(() => {
        console.log('Reconnected to Redis');
      }).catch((err) => {
        console.error('Failed to reconnect to Redis:', err);
      });
    } else {
      console.log(
        `Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`
      );
    }
  }
  
  public connect() {
    try {
      console.log(`Connecting to FIX server at ${FIX_SERVER}:${FIX_PORT}...`);
      this.client.connect(Number(FIX_PORT), FIX_SERVER);
    } catch (error) {
      console.error("Error connecting to FIX server:", error);
      this.reconnect();
    }
  }

  public subscribeToMarketData() {
    if (!isConnected) {
      console.log(
        "Not connected to FIX server. Cannot subscribe to market data."
      );
      return;
    }


    const pairsToSubscribe = availableCurrencyPairs.filter((pair) =>
      subscribedPairs.has(pair.currpair)
    );

    // console.log(`Found ${pairsToSubscribe.length} valid pairs to subscribe`);

    for (const pair of pairsToSubscribe) {
      // console.log(
      //   `Subscribing to market data for ${pair.currpair} with contract size ${pair.contractsize}`
      // );

      sequenceNumber++;

      const uniqueId = uuidv4();
      const mdReqId = `MDR_${uniqueId}`;

      const messageBody = [
        "35=V", // Message Type (V = Market Data Request)
        `49=${SENDER_COMP_ID}`, // SenderCompID
        `56=${TARGET_COMP_ID}`, // TargetCompID
        `34=${sequenceNumber}`, // MsgSeqNum
        `52=${getUTCTimestamp()}`, // SendingTime
        `262=${mdReqId}`, // MDReqID (unique identifier)
        "263=1", // SubscriptionRequestType (1 = Snapshot + Updates)
        "264=0", // MarketDepth (0 = Full Book)
        "267=2", // NoMDEntryTypes (2 types: BID and ASK)
        "269=0", // First MDEntryType - BID
        "269=1", // Second MDEntryType - ASK
        "146=1", // NoRelatedSym (1 symbol)
        `55=${pair.currpair}`, // Symbol
      ].join("\u0001");

      const bodyLength = messageBody.length;
      let fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`;

      const checksum = calculateChecksum(fullMessage + "\u0001");
      fullMessage = `${fullMessage}\u000110=${checksum}\u0001`;

      this.client.write(fullMessage);

      // console.log(`Sent market data subscription request for ${pair.currpair}`);

      // Add a small delay between requests to prevent overwhelming the server
      if (pairsToSubscribe.indexOf(pair) < pairsToSubscribe.length - 1) {
        // console.log("Waiting before sending next subscription...");
        setTimeout(() => { }, 200);
      }
    }
  }

  public disconnect() {
    if (isConnected) {
      const logoutMessage = createFixMessage({
        35: "5", // Logout
      });
      this.client.write(logoutMessage);
      console.log("Logout message sent");
    }
    this.client.end();
  }
}

const fixClient = new FixClient();

fixClient.connect();

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  fixClient.disconnect();

  console.log("Closing Bull queue...");
  await marketDataQueue.close();
  await candleProcessingQueue.close();

  console.log("Closing Redis connection...");
  await redisClient.quit();

  pgPool.end().then(() => {
    console.log("Database connection closed");
    process.exit(0);
  });
});