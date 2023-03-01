import { WorkerMessenger } from "../libraries/WorkerMessenger";
import Database from "../services/Database";
import ConditionalLog from "../libraries/sw/ConditionalLog";
import { OSServiceWorkerFields  } from "./types";
import { mkRuntime, } from "./OSServiceWorkerRuntime";
import bowser from "bowser";
import { mkEventHandling } from "./OSServiceWorkerEventHandling";
import { mkServiceWorker, OSServiceWorker } from "./OSServiceWorker";
import { mkMessageHandlers } from "./OSServiceWorkerMessageHandlers";

// Even though the runtime gives us this object as global scope, we can
// still parameterize it here for dependency injection and testability.
declare var self: ServiceWorkerGlobalScope & OSServiceWorkerFields;

let workerMessenger: WorkerMessenger | undefined;

const selfExists = (typeof self !== "undefined") || (typeof global === "undefined")
const providedSelf: any = selfExists ? self : global

if (selfExists) {
  workerMessenger = (providedSelf as any).workerMessenger || new WorkerMessenger(null!);
}

const runtime = mkRuntime({
  providedSelf,
  workerMessenger,
  database: Database,
  conditionalLog: ConditionalLog,
  browser: bowser,
})

const messageHandlers = mkMessageHandlers({ runtime })
const eventHandling = mkEventHandling({ runtime, messageHandlers });
const sw: OSServiceWorker = mkServiceWorker({ runtime, eventHandling });

export const ServiceWorker = sw;

providedSelf.OneSignalWorker = sw;
if (selfExists) {
  sw.run();
}

