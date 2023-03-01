
export default class ConditionalLog {
  private static logInstance: ConditionalLog | null;
  private enabled: boolean;

  public static resetInstance(enabled: boolean = false): void {
    ConditionalLog.logInstance = new ConditionalLog(enabled);
  }

  public static get singletonInstance(): ConditionalLog {
    if (!ConditionalLog.logInstance) {
      ConditionalLog.logInstance = new ConditionalLog();
    }
    return ConditionalLog.logInstance;
  }

  static debug(...args: any[]): void {
    ConditionalLog.singletonInstance.debug(...args)
  }

  static trace(...args: any[]): void {
    ConditionalLog.singletonInstance.trace(...args);
  }

  static info(...args: any[]): void {
    ConditionalLog.singletonInstance.info(...args);
  }

  static warn(...args: any[]): void {
    ConditionalLog.singletonInstance.warn(...args);
  }

  static error(...args: any[]): void {
    ConditionalLog.singletonInstance.error(...args);
  }

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  debug(...args: any[]): void {
    if (!!this.enabled) {
      console.debug(...args);
    }
  }

  trace(...args: any[]): void {
    if (!!this.enabled) {
      console.trace(...args);
    }
  }

  info(...args: any[]): void {
    if (!!this.enabled) {
      console.info(...args);
    }
  }

  warn(...args: any[]): void {
    if (!!this.enabled) {
      console.warn(...args);
    }
  }

  error(...args: any[]): void {
    if (!!this.enabled) {
      console.error(...args);
    }
  }
}
