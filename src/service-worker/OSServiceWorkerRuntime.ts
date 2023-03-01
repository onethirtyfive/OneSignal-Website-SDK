// Since Environment is static methods on a class, we wrap it for a level

import bowser from "bowser";
import { IBowser } from "bowser";
import Environment from "../Environment";
import ConditionalLog from "../libraries/sw/ConditionalLog";
import { WorkerMessenger } from "../libraries/WorkerMessenger";
import Database from "../services/Database";
import { OSServiceWorkerFields } from "./types";

// Since Environment is static methods on a class, we wrap it for a level
// of indirection that increases testing surface area.
export interface OSServiceWorkerEnvironmentWrapper {
  version: () => number
}

export interface OSServiceWorkerRuntime {
  providedSelf: ServiceWorkerGlobalScope & OSServiceWorkerFields
  workerMessenger: WorkerMessenger;
  Database: typeof Database;
  database: () => Database;
  ConditionalLog: typeof ConditionalLog;
  conditionalLog: () => ConditionalLog;
  environment: OSServiceWorkerEnvironmentWrapper
  getAppId(): Promise<string>;
  browser: IBowser;
}

export interface FnMkOSServiceWorkerRuntimeOptions {
  providedSelf: ServiceWorkerGlobalScope & OSServiceWorkerFields
  workerMessenger?: WorkerMessenger;
  conditionalLog?: typeof ConditionalLog;
  database?: typeof Database;
  browser?: IBowser;
}

type FnMkOSServiceWorkerRuntime = (options: FnMkOSServiceWorkerRuntimeOptions) => OSServiceWorkerRuntime

export const mkRuntime: FnMkOSServiceWorkerRuntime = ({
  providedSelf,
  workerMessenger = new WorkerMessenger(null!),
  database = Database,
  conditionalLog = ConditionalLog,
  browser = bowser
}) => {
  return {
    providedSelf, // dependency-injected `self`

    /**
    * Allows message passing between this service worker and pages on the same domain.
    * Clients include any HTTPS site page, or the nested iFrame pointing to OneSignal on any HTTP site. This allows
    * events like notification dismissed, clicked, and displayed to be fired on the clients. It also allows the
    * clients to communicate with the service worker to close all active notifications.
    */
    workerMessenger,
    Database: database, // the type (class)
    database: () => database.singletonInstance, // needs to be lazy because of singleton resetting
    ConditionalLog: conditionalLog, // the type (class)
    conditionalLog: () => conditionalLog.singletonInstance, // needs to be lazy because of singleton resetting
    browser,

    environment: {
      version: () => Environment.version()
    },

    getAppId: async function(): Promise<string> {
      if (providedSelf.location.search) {
        const match = providedSelf.location.search.match(/appId=([0-9a-z-]+)&?/i);
        // Successful regex matches are at position 1
        if (match && match.length > 1) {
          const appId = match[1];
          return appId;
        }
      }
      const { appId } = await database.singletonInstance.getAppConfig();
      return appId;
    },
  }
}

