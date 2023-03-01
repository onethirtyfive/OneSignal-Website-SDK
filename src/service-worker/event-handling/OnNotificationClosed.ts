import Utils from "../../context/shared/utils/Utils";
import { WorkerMessengerCommand } from "../../libraries/WorkerMessenger";
import { OSServiceWorkerEventHandling } from "../OSServiceWorkerEventHandling";
import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime"

export interface OSServiceWorkerEventOnNotificationClosed {
  onNotificationClosed(event: Event): void;
}

export const mk: (
  (runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventOnNotificationClosed
) = function({ conditionalLog, workerMessenger, }) {
  return {
    /**
    * Occurs when a notification is dismissed by the user (clicking the 'X') or all notifications are cleared.
    * Supported on: Chrome 50+ only
    */
    onNotificationClosed: function(
      this: OSServiceWorkerEventHandling,
      event: any
    ): void {
      conditionalLog().debug(`Called %conNotificationClosed(${JSON.stringify(event, null, 4)}):`, Utils.getConsoleStyle('code'), event);
      const notification = event.notification.data;

      workerMessenger.broadcast(WorkerMessengerCommand.NotificationDismissed, notification).catch(e => conditionalLog().error(e));
      event.waitUntil(
        this.executeWebhooks('notification.dismissed', notification)
      );
    },
  }
}

