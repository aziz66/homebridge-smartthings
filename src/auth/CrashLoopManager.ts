import { Logger } from 'homebridge';
import fs from 'fs-extra';
import path from 'path';

const CRASH_LOG_FILE = 'crash_loop_log.json';
const MAX_LOG_ENTRIES = 20; // Keep the log from growing indefinitely to save space

// Define specific error types that we consider relevant for loop detection
export const enum CrashErrorType {
  API_INIT_FAILURE = 'API_INIT_FAILURE', // Failure during initial device/API fetch in didFinishLaunching
  DEVICE_HEALTH_FAILURE = 'DEVICE_HEALTH_FAILURE', // Failure during device health check
  TOKEN_REFRESH_FAILURE = 'TOKEN_REFRESH_FAILURE', // Failure during token refresh
  UNKNOWN_API_FAILURE = 'UNKNOWN_API_FAILURE', // Generic API failure that might lead to a crash
}

interface CrashEvent {
  timestamp: number;
  errorType: CrashErrorType | string; // Allow specific enum or general strings
}

export interface CrashLoopConfig {
  maxCrashes: number;
  timeWindowMinutes: number;
  relevantErrorTypes: (CrashErrorType | string)[];
}

export class CrashLoopManager {
  private storagePath: string;
  private log: Logger;
  private crashLogFilePath: string;
  private static instance: CrashLoopManager | null = null;

  // Make constructor private for singleton
  private constructor(storagePath: string, log: Logger) {
    this.storagePath = storagePath;
    this.log = log;
    this.crashLogFilePath = path.join(this.storagePath, CRASH_LOG_FILE);
    this.log.debug(`CrashLoopManager initialized. Log file path: ${this.crashLogFilePath}`);
  }

  // Static method to get instance (Singleton pattern)
  public static getInstance(storagePath: string, log: Logger): CrashLoopManager {
    if (!CrashLoopManager.instance) {
      CrashLoopManager.instance = new CrashLoopManager(storagePath, log);
    }
    return CrashLoopManager.instance;
  }

  private async readCrashLog(): Promise<CrashEvent[]> {
    try {
      await fs.ensureDir(this.storagePath); // Ensure storage directory exists
      if (await fs.pathExists(this.crashLogFilePath)) {
        const data = await fs.readJson(this.crashLogFilePath);
        return Array.isArray(data) ? data : [];
      }
      return [];
    } catch (error) {
      this.log.error('Error reading crash log:', error);
      return [];
    }
  }

  private async writeCrashLog(logData: CrashEvent[]): Promise<void> {
    try {
      await fs.ensureDir(this.storagePath); // Ensure storage directory exists
      // Prune old entries if log is too long
      if (logData.length > MAX_LOG_ENTRIES) {
        logData = logData.slice(logData.length - MAX_LOG_ENTRIES);
      }
      await fs.writeJson(this.crashLogFilePath, logData, { spaces: 2 });
    } catch (error) {
      this.log.error('Error writing crash log:', error);
    }
  }

  public async recordPotentialCrash(errorType: CrashErrorType | string): Promise<void> {
    this.log.info(`Recording potential crash event of type: ${errorType}`);
    const crashes = await this.readCrashLog();
    crashes.push({ timestamp: Date.now(), errorType });
    await this.writeCrashLog(crashes);
  }

  public async isCrashLoopDetected(config: CrashLoopConfig): Promise<boolean> {
    const crashes = await this.readCrashLog();
    if (crashes.length === 0) {
        this.log.debug('No crash events recorded yet.');
        return false;
    }

    const timeWindowMs = config.timeWindowMinutes * 60 * 1000;
    const now = Date.now();

    const recentRelevantCrashes = crashes.filter(crash =>
      (now - crash.timestamp) <= timeWindowMs &&
      (config.relevantErrorTypes.length === 0 || config.relevantErrorTypes.includes(crash.errorType)),
    );

    this.log.debug(`Found ${recentRelevantCrashes.length} relevant crash(es) in the last ${config.timeWindowMinutes} minutes. Need ${config.maxCrashes} for loop detection.`);

    if (recentRelevantCrashes.length >= config.maxCrashes) {
      this.log.warn(`Crash loop DETECTED: ${recentRelevantCrashes.length} relevant crashes in the last ${config.timeWindowMinutes} minutes.`);
      return true;
    }
    return false;
  }

  public async resetCrashState(): Promise<void> {
    this.log.info('Resetting crash loop detection state (clearing crash log).');
    await this.writeCrashLog([]);
  }
}

// Default configuration for crash loop detection
export const defaultCrashLoopConfig: CrashLoopConfig = {
  maxCrashes: 5, // Number of crashes to detect a loop
  timeWindowMinutes: 15, // Time window in minutes
  relevantErrorTypes: [CrashErrorType.API_INIT_FAILURE, CrashErrorType.DEVICE_HEALTH_FAILURE, CrashErrorType.TOKEN_REFRESH_FAILURE], // Only these types contribute to loop detection
};