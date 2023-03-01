import Utils from "../../context/shared/utils/Utils";
import { DeviceRecord } from "../../models/DeviceRecord";
import OneSignalApiBase from "../../OneSignalApiBase";
import { OSWindowClient } from "../types"
import { awaitableTimeout } from "../../utils/AwaitableTimeout";
import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime";

const MAX_CONFIRMED_DELIVERY_DELAY = 25;

export interface OSServiceWorkerEventCommon {
  UNSUBSCRIBED_FROM_NOTIFICATIONS: undefined,

  executeWebhooks(event: string, notification: any): Promise<Response | null>;
  sendConfirmedDelivery(notification: any): Promise<Response | null>;
  getActiveClients(): Promise<Array<OSWindowClient>>;
}

export const mk: (
  runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventCommon =
function(
  { database, conditionalLog, getAppId, providedSelf }
) {
  return {
    UNSUBSCRIBED_FROM_NOTIFICATIONS: undefined,

    /**
    * Makes a POST call to a specified URL to forward certain events.
    * @param event The name of the webhook event. Affects the DB key pulled for settings and the final event the user
    *              consumes.
    * @param notification A JSON object containing notification details the user consumes.
    * @returns {Promise}
    */
    executeWebhooks: async function(event: string, notification: any): Promise<Response | null> {
      const webhookTargetUrl = await database().get<string>('Options', `webhooks.${event}`);
      if (!webhookTargetUrl)
        return null;

      const { deviceId } = await database().getSubscription();
      const isServerCorsEnabled = await database().get<boolean>('Options', 'webhooks.cors');

      // JSON.stringify() does not include undefined values
      // Our response will not contain those fields here which have undefined values
      const postData = {
        event: event,
        id: notification.id,
        userId: deviceId,
        action: notification.action,
        buttons: notification.buttons,
        heading: notification.heading,
        content: notification.content,
        url: notification.url,
        icon: notification.icon,
        data: notification.data
      };
      const fetchOptions: RequestInit = {
        method: 'post',
        mode: 'no-cors',
        body: JSON.stringify(postData),
      };

      if (isServerCorsEnabled) {
        fetchOptions.mode = 'cors';
        fetchOptions.headers = {
          'X-OneSignal-Event': event,
          'Content-Type': 'application/json'
        };
      }
      conditionalLog().debug(
        `Executing ${event} webhook ${isServerCorsEnabled ? 'with' : 'without'} CORS %cPOST ${webhookTargetUrl}`,
        Utils.getConsoleStyle('code'), ':', postData
      );
      return await fetch(webhookTargetUrl, fetchOptions);
    },

    /**
    * Makes a PUT call to log the delivery of the notification
    * @param notification A JSON object containing notification details.
    * @returns {Promise}
    */
    sendConfirmedDelivery: async function(notification: any): Promise<Response | null> {
      if (!notification)
      return null;

      // Received receipts enabled?
      if (notification.rr !== "y")
      return null;

      const appId = await getAppId();
      const { deviceId } = await database().getSubscription();

      // app and notification ids are required, decided to exclude deviceId from required params
      // In rare case we don't have it we can still report as confirmed to backend to increment count
      const hasRequiredParams = !!(appId && notification.id);
      if (!hasRequiredParams) {
        return null;
      }

      // JSON.stringify() does not include undefined values
      // Our response will not contain those fields here which have undefined values
      const postData = {
        player_id : deviceId,
        app_id : appId,
        device_type: DeviceRecord.prototype.getDeliveryPlatform()
      };

      conditionalLog().debug(`Called %csendConfirmedDelivery(${
      JSON.stringify(notification, null, 4)
      })`, Utils.getConsoleStyle('code'));

      await awaitableTimeout(Math.floor(Math.random() * MAX_CONFIRMED_DELIVERY_DELAY * 1_000));
      return await OneSignalApiBase.put(`notifications/${notification.id}/report_received`, postData);
    },

    /**
    * Gets an array of active window clients along with whether each window client is the HTTP site's iFrame or an
    * HTTPS site page.
    * An active window client is a browser tab that is controlled by the service worker.
    * Technically, this list should only ever contain clients that are iFrames, or clients that are HTTPS site pages,
    * and not both. This doesn't really matter though.
    * @returns {Promise}
    */
    getActiveClients: async function(): Promise<Array<OSWindowClient>> {
      const windowClients: ReadonlyArray<Client> = await providedSelf.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });
      const activeClients: Array<OSWindowClient> = [];

      for (const client of windowClients) {
        const windowClient: OSWindowClient = client as OSWindowClient;
        windowClient.isSubdomainIframe = false;
        // Test if this window client is the HTTP subdomain iFrame pointing to subdomain.onesignal.com
        if (client.frameType && client.frameType === 'nested') {
          // Subdomain iFrames point to 'https://subdomain.onesignal.com...'
          if (!Utils.contains(client.url, '.os.tc') &&
            !Utils.contains(client.url, '.onesignal.com')) {
            continue;
          }
          // Indicates this window client is an HTTP subdomain iFrame
          windowClient.isSubdomainIframe = true;
        }
        activeClients.push(windowClient);
      }
      return activeClients;
    },
  }
}


