import ServiceWorkerHelper from "../../helpers/ServiceWorkerHelper";
import { cancelableTimeout } from "../../helpers/sw/CancelableTimeout";
import { WorkerMessengerCommand } from "../../libraries/WorkerMessenger";
import { DeactivateSessionPayload, PageVisibilityRequest } from "../../models/Session";
import { OSServiceWorkerEventHandling } from "../OSServiceWorkerEventHandling";
import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime";
import { OSServiceWorkerEventCommon } from "./Common";

export interface OSServiceWorkerEventDebounceRefreshSession {
  updateSessionBasedOnHasActive(
    event: ExtendableMessageEvent,
    hasAnyActiveSessions: boolean, options: DeactivateSessionPayload
  ): Promise<void>;
  checkIfAnyClientsFocusedAndUpdateSession(
    event: ExtendableMessageEvent,
    windowClients: ReadonlyArray<Client>,
    sessionInfo: DeactivateSessionPayload
  ): Promise<void>;
  refreshSession(event: ExtendableMessageEvent, options: DeactivateSessionPayload): Promise<void>;
  debounceRefreshSession(event: ExtendableMessageEvent, options: DeactivateSessionPayload): void;
}

export const mk: (
  (runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventDebounceRefreshSession
) = function({ providedSelf, conditionalLog }) {
  return {
    updateSessionBasedOnHasActive: async function(
      this: OSServiceWorkerEventHandling,
      event: ExtendableMessageEvent,
      hasAnyActiveSessions: boolean, options: DeactivateSessionPayload
    ): Promise<void> {
      if (hasAnyActiveSessions) {
        await ServiceWorkerHelper.upsertSession(
          options.sessionThreshold,
          options.enableSessionDuration,
          options.deviceRecord!,
          options.deviceId,
          options.sessionOrigin,
          options.outcomesConfig
        );
      } else {
        const cancelableFinalize = await ServiceWorkerHelper.deactivateSession(
          options.sessionThreshold, options.enableSessionDuration, options.outcomesConfig
        );
        if (cancelableFinalize) {
          providedSelf.cancel = cancelableFinalize.cancel;
          event.waitUntil(cancelableFinalize.promise);
        }
      }
    },

    checkIfAnyClientsFocusedAndUpdateSession: async function(
      this: OSServiceWorkerEventHandling,
      event: ExtendableMessageEvent,
      windowClients: ReadonlyArray<Client>,
      sessionInfo: DeactivateSessionPayload
    ): Promise<void> {
      const timestamp = new Date().getTime();
      providedSelf.clientsStatus = {
        timestamp,
        sentRequestsCount: 0,
        receivedResponsesCount: 0,
        hasAnyActiveSessions: false,
      };
      const payload: PageVisibilityRequest = { timestamp };
      windowClients.forEach(c => {
        if (providedSelf.clientsStatus) {
          // keeping track of number of sent requests mostly for debugging purposes
          providedSelf.clientsStatus.sentRequestsCount++;
        }
        c.postMessage({ command: WorkerMessengerCommand.AreYouVisible, payload });
      });
      const updateOnHasActive = async () => {
        if (!providedSelf.clientsStatus) { return; }
        if (providedSelf.clientsStatus.timestamp !== timestamp) { return; }

        conditionalLog().debug("updateSessionBasedOnHasActive", providedSelf.clientsStatus);
        await this.updateSessionBasedOnHasActive(event,
          providedSelf.clientsStatus.hasAnyActiveSessions, sessionInfo);
        providedSelf.clientsStatus = undefined;
      };
      const getClientStatusesCancelable = cancelableTimeout(updateOnHasActive, 0.5);
      providedSelf.cancel = getClientStatusesCancelable.cancel;
      event.waitUntil(getClientStatusesCancelable.promise);
    },

    refreshSession: async function(
      this: OSServiceWorkerEventHandling,
      event: ExtendableMessageEvent,
      options: DeactivateSessionPayload
    ): Promise<void> {
      conditionalLog().debug("[Service Worker] refreshSession");
      /**
      * if https -> getActiveClients -> check for the first focused
      * unfortunately, not enough for safari, it always returns false for focused state of a client
      * have to workaround it with messaging to the client.
      *
      * if http, also have to workaround with messaging:
      *   SW to iframe -> iframe to page -> page to iframe -> iframe to SW
      */
      if (options.isHttps) {
        const windowClients: ReadonlyArray<Client> = await providedSelf.clients.matchAll(
          { type: "window", includeUncontrolled: true }
        );

        if (options.isSafari) {
          await this.checkIfAnyClientsFocusedAndUpdateSession(event, windowClients, options);
        } else {
          const hasAnyActiveSessions: boolean = windowClients.some(w => (w as WindowClient).focused);
          conditionalLog().debug("[Service Worker] isHttps hasAnyActiveSessions", hasAnyActiveSessions);
          await this.updateSessionBasedOnHasActive(event, hasAnyActiveSessions, options);
        }
        return;
      } else {
        const osClients = await this.getActiveClients();
        await this.checkIfAnyClientsFocusedAndUpdateSession(event, osClients, options);
      }
    },

    debounceRefreshSession: function(
      this: OSServiceWorkerEventHandling,
      event: ExtendableMessageEvent,
      options: DeactivateSessionPayload
    ) {
      conditionalLog().debug("[Service Worker] debounceRefreshSession", options);

      if (providedSelf.cancel) {
        providedSelf.cancel();
        providedSelf.cancel = undefined;
      }

      const executeRefreshSession = async () => {
        await this.refreshSession(event, options);
      };

      const cancelableRefreshSession = cancelableTimeout(executeRefreshSession, 1);
      providedSelf.cancel = cancelableRefreshSession.cancel;
      event.waitUntil(cancelableRefreshSession.promise);
    },
  }
}

