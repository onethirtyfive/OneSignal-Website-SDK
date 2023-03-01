import { WorkerMessengerCommand, WorkerMessengerMessage } from "../libraries/WorkerMessenger";
import { DeactivateSessionPayload, UpsertSessionPayload } from "../models/Session";
import { OSServiceWorkerEventHandling } from "./OSServiceWorkerEventHandling";
import { OSServiceWorkerRuntime } from "./OSServiceWorkerRuntime";

/**
 * The main service worker script fetching and displaying notifications to users in the background even when the client
 * site is not running. The worker is registered via the navigator.serviceWorker.register() call after the user first
 * allows notification permissions, and is a pre-requisite to subscribing for push notifications.
 *
 * For HTTPS sites, the service worker is registered site-wide at the top-level scope. For HTTP sites, the service
 * worker is registered to the iFrame pointing to subdomain.onesignal.com.
 */

export interface OSServiceWorkerBasis {
  VERSION: number;
  run(): void;
}

export type OSServiceWorker =
  OSServiceWorkerBasis &
  OSServiceWorkerRuntime &
  OSServiceWorkerEventHandling

export interface MkServiceWorkerOptions {
  runtime: OSServiceWorkerRuntime;
  eventHandling: OSServiceWorkerEventHandling;
}

type FnMkServiceWorker = (options: MkServiceWorkerOptions) => OSServiceWorker

export const mkServiceWorker: FnMkServiceWorker = ({ runtime, eventHandling }) => {
  // Things we need form the runtime, available to the service worker.
  const {
    providedSelf,
    conditionalLog,
    environment,
    workerMessenger
  } = runtime

  const basis: OSServiceWorkerBasis = {
    /**
    * An incrementing integer defined in package.json. Value doesn't matter as long as it's different from the
    * previous version.
    */
    VERSION: environment.version(),

    /**
    * Service worker entry point.
    */
    run: function(): void {
      // Now, absent `class` semantics, we can see locally: `this === self`
      providedSelf.addEventListener('activate', eventHandling.onServiceWorkerActivated);
      providedSelf.addEventListener('push', eventHandling.onPushReceived);
      providedSelf.addEventListener('notificationclose', eventHandling.onNotificationClosed);
      providedSelf.addEventListener('notificationclick', event => event.waitUntil(eventHandling.onNotificationClicked(event)));
      providedSelf.addEventListener('pushsubscriptionchange', (event: PushSubscriptionChangeEvent) => {
        event.waitUntil(eventHandling.onPushSubscriptionChange(event));
      });

      providedSelf.addEventListener('message', (event: ExtendableMessageEvent) => {
        const data: WorkerMessengerMessage = event.data;
        if (!data || !data.command) {
          return;
        }
        const payload = data.payload;

        switch(data.command) {
          case WorkerMessengerCommand.SessionUpsert:
            conditionalLog().debug("[Service Worker] Received SessionUpsert", payload);
            eventHandling.debounceRefreshSession(event, payload as UpsertSessionPayload);
            break;
          case WorkerMessengerCommand.SessionDeactivate:
            conditionalLog().debug("[Service Worker] Received SessionDeactivate", payload);
            eventHandling.debounceRefreshSession(event, payload as DeactivateSessionPayload);
            break;
          default:
            return;
        }
      });
      /*
      According to
      https://w3c.github.io/ServiceWorker/#run-service-worker-algorithm:

      "user agents are encouraged to show a warning that the event listeners
      must be added on the very first evaluation of the worker script."

      We have to register our event handler statically (not within an
      asynchronous method) so that the browser can optimize not waking up the
      service worker for events that aren't known for sure to be listened for.

      Also see: https://github.com/w3c/ServiceWorker/issues/1156
      */
      conditionalLog().debug('Setting up message listeners.');
      // providedSelf.addEventListener('message') is statically added inside the listen() method
      workerMessenger.listen();
      // Install messaging event handlers for page <-> service worker communication
      eventHandling.setupMessageListeners();
    },
  }

  const sw = {};

  const rebind = (src: any) =>
    Object.assign(
      {},
      ...Object.keys(src).map(k => {
        const value = (src as any)[k];
        const isFunction = typeof value === "function";
        return isFunction ? { [k]: value.bind(sw) } : { [k]: value };
      })
    );

  Object.assign(sw, rebind(basis), rebind(runtime), rebind(eventHandling));

  return sw as OSServiceWorker;
}


