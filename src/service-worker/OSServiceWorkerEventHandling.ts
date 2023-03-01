import { WorkerMessengerCommand } from "../libraries/WorkerMessenger"
import { mk as mkCommon, OSServiceWorkerEventCommon } from "./event-handling/Common"
import { mk as mkDebounceRefreshSession, OSServiceWorkerEventDebounceRefreshSession } from "./event-handling/DebounceRefreshSession"
import { mk as mkOnNotificationClicked, OSServiceWorkerEventOnNotificationClicked } from "./event-handling/OnNotificationClicked"
import { mk as mkOnNotificationClosed, OSServiceWorkerEventOnNotificationClosed } from "./event-handling/OnNotificationClosed"
import { mk as mkOnPushReceived, OSServiceWorkerEventOnPushReceived } from "./event-handling/OnPushReceived"
import { mk as mkOnPushSubscriptionChange, OSServiceWorkerEventOnPushSubscriptionChange } from "./event-handling/OnPushSubscriptionChange"
import { mk as mkOnServiceWorkerActivated, OSServiceWorkerEventOnServiceWorkerActivated } from "./event-handling/OnServiceWorkerActivated"
import { OSServiceWorkerMessageHandlers } from "./OSServiceWorkerMessageHandlers"
import { OSServiceWorkerRuntime } from "./OSServiceWorkerRuntime"

export interface MkOSServiceWorkerEventHandlingOptions {
  runtime: OSServiceWorkerRuntime;
  messageHandlers: OSServiceWorkerMessageHandlers;
}

export type OSServiceWorkerEventHandling =
  OSServiceWorkerEventCommon &
  OSServiceWorkerEventDebounceRefreshSession &
  OSServiceWorkerEventOnNotificationClicked &
  OSServiceWorkerEventOnNotificationClosed &
  OSServiceWorkerEventOnPushReceived &
  OSServiceWorkerEventOnPushSubscriptionChange &
  OSServiceWorkerEventOnServiceWorkerActivated &
  { setupMessageListeners: () => void }

export const mkEventHandling: (
  (options: MkOSServiceWorkerEventHandlingOptions) => OSServiceWorkerEventHandling
) = function({ runtime, messageHandlers }) {
  const { workerMessenger } = runtime

  return {
    ...mkCommon(runtime),
    ...mkDebounceRefreshSession(runtime),
    ...mkOnNotificationClicked(runtime),
    ...mkOnNotificationClosed(runtime),
    ...mkOnPushReceived(runtime),
    ...mkOnPushSubscriptionChange(runtime),
    ...mkOnServiceWorkerActivated(runtime),

    setupMessageListeners: function(): void {
      for (const command in messageHandlers) {
        workerMessenger.on(command as WorkerMessengerCommand, messageHandlers[command]!)
      }
    },
  };
};

