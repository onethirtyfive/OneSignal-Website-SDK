import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime";

export interface OSServiceWorkerEventOnServiceWorkerActivated {
  onServiceWorkerActivated(event: ExtendableEvent): void
}

export const mk: (
  (runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventOnServiceWorkerActivated
) = function({ conditionalLog, environment, providedSelf }) {
  return {
    /**
     * Fires when the ServiceWorker can control pages.
     * REQUIRED: AMP WebPush (amp-web-push v0.1) requires clients.claim()
     *    - It depends on ServiceWorker having full control of the iframe,
     *      requirement could be lifted by AMP in the future however.
     *    - Without this the AMP symptom is the subscribe button does not update
     *      right after accepting the notification permission from the pop-up.
     * @param event
     */
    onServiceWorkerActivated: function(event: ExtendableEvent): void {
      conditionalLog().info(`OneSignal Service Worker activated (version ${environment.version()})`);
      event.waitUntil(providedSelf.clients.claim());
    },
  }
}

