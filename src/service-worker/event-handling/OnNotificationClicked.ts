import Utils from "../../context/shared/utils/Utils"
import { WorkerMessengerCommand } from "../../libraries/WorkerMessenger"
import { DeviceRecord } from "../../models/DeviceRecord"
import { NotificationClicked } from "../../models/Notification"
import { SessionStatus } from "../../models/Session"
import OneSignalApiBase from "../../OneSignalApiBase"
import { OSServiceWorkerEventHandling } from "../OSServiceWorkerEventHandling"
import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime"
import { OSServiceWorkerEventCommon } from "./Common"

export interface OSServiceWorkerEventOnNotificationClicked {
  // helpers and implementation for `onNotificationClicked`
  getNotificationUrlToOpen(notification: any): Promise<string>;
  shouldOpenNotificationUrl(url: string): boolean;
  sendConvertedAPIRequests(
    appId: string | undefined | null,
    deviceId: string | undefined,
    notificationData: any,
    deviceType: number
  ): Promise<void>;
  openUrl(url: string): Promise<Client | null>;
  onNotificationClicked(event: NotificationEventInit): Promise<void>;
}

export const mk: (
  (runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventOnNotificationClicked
) = function(
  this: OSServiceWorkerEventHandling,
  { database, conditionalLog, providedSelf, getAppId, workerMessenger }
) {
  return {
    /**
    * After clicking a notification, determines the URL to open based on whether an action button was clicked or the
    * notification body was clicked.
    */
    getNotificationUrlToOpen: async function(notification: any): Promise<string> {
      // Defaults to the URL the service worker was registered
      // TODO: This should be fixed for HTTP sites
      let launchUrl = location.origin;

      // Use the user-provided default URL if one exists
      const { defaultNotificationUrl: dbDefaultNotificationUrl } = await database().getAppState();
      if (dbDefaultNotificationUrl)
      launchUrl = dbDefaultNotificationUrl;

      // If the user clicked an action button, use the URL provided by the action button
      // Unless the action button URL is null
      if (notification.action) {
        // Find the URL tied to the action button that was clicked
        for (const button of notification.buttons) {
          if (button.action === notification.action &&
            button.url &&
            button.url !== '') {
            launchUrl = button.url;
          }
        }
      } else if (notification.url &&
        notification.url !== '') {
        // The user clicked the notification body instead of an action button
        launchUrl = notification.url;
      }

      return launchUrl;
    },

    /**
    * Returns false if the given URL matches a few special URLs designed to skip opening a URL when clicking a
    * notification. Otherwise returns true and the link will be opened.
    * @param url
    */
    shouldOpenNotificationUrl: function(url: string): boolean {
      return (url !== 'javascript:void(0);' &&
        url !== 'do_not_open' &&
        !Utils.contains(url, '_osp=do_not_open'));
    },

    /**
    * Makes network calls for the notification open event to;
    *    1. OneSignal.com to increase the notification open count.
    *    2. A website developer defined webhook URL, if set.
    */
    sendConvertedAPIRequests: async function(
      this: OSServiceWorkerEventHandling,
      appId: string | undefined | null,
      deviceId: string | undefined,
      notificationData: any,
      deviceType: number): Promise<void> {

      if (!notificationData.id) {
        console.error("No notification id, skipping networks calls to report open!");
        return;
      }

      let onesignalRestPromise: Promise<any> | undefined;

      if (appId) {
        onesignalRestPromise = OneSignalApiBase.put(`notifications/${notificationData.id}`, {
          app_id: appId,
          player_id: deviceId,
          opened: true,
          device_type: deviceType
        });
      }
      else
        console.error("No app Id, skipping OneSignal API call for notification open!");

      await this.executeWebhooks('notification.clicked', notificationData);
      if (onesignalRestPromise)
        await onesignalRestPromise;
    },

    /**
    * Attempts to open the given url in a new browser tab. Called when a notification is clicked.
    * @param url May not be well-formed.
    */
    openUrl: async function(
      this: OSServiceWorkerEventHandling,
      url: string
    ): Promise<Client | null> {
      conditionalLog().debug('Opening notification URL:', url);
      try {
        return await providedSelf.clients.openWindow(url);
      } catch (e) {
        conditionalLog().warn(`Failed to open the URL '${url}':`, e);
        return null;
      }
    },

    /**
    * Returns a promise that is fulfilled with either the default title from the database (first priority) or the page title from the database (alternate result).
    */
    /**
    * Occurs when the notification's body or action buttons are clicked. Does not occur if the notification is
    * dismissed by clicking the 'X' icon. See the notification close event for the dismissal event.
    */
    onNotificationClicked: async function(
      this: OSServiceWorkerEventHandling,
      event: NotificationEventInit
    ): Promise<void> {
      conditionalLog().debug(`Called %conNotificationClicked(${JSON.stringify(event, null, 4)}):`, Utils.getConsoleStyle('code'), event);

      // Close the notification first here, before we do anything that might fail
      event.notification.close();

      const notificationData = event.notification.data;

      // Chrome 48+: Get the action button that was clicked
      if (event.action)
        notificationData.action = event.action;

      let notificationClickHandlerMatch = 'exact';
      let notificationClickHandlerAction = 'navigate';

      const matchPreference = await database().get<string>('Options', 'notificationClickHandlerMatch');
      if (matchPreference)
        notificationClickHandlerMatch = matchPreference;

      const actionPreference = await database().get<string>('Options', 'notificationClickHandlerAction');
      if (actionPreference)
        notificationClickHandlerAction = actionPreference;

      const launchUrl: string = await this.getNotificationUrlToOpen(notificationData);
      const notificationOpensLink: boolean = this.shouldOpenNotificationUrl(launchUrl);
      const appId = await getAppId();
      const deviceType = DeviceRecord.prototype.getDeliveryPlatform();

      let saveNotificationClickedPromise: Promise<void> | undefined;
      const notificationClicked: NotificationClicked = {
        notificationId: notificationData.id,
        appId,
        url: launchUrl,
        timestamp: new Date().getTime(),
      };
      conditionalLog().info("NotificationClicked", notificationClicked);
      saveNotificationClickedPromise = (async notificationClicked => {
        try {
          const existingSession = await database().getCurrentSession();
          if (existingSession && existingSession.status === SessionStatus.Active) {
            return;
          }
          await database().put("NotificationClicked", notificationClicked);

          // upgrade existing session to be directly attributed to the notif
          // if it results in re-focusing the site
          if (existingSession) {
            existingSession.notificationId = notificationClicked.notificationId;
            await database().upsertSession(existingSession);
          }
        } catch(e) {
          conditionalLog().error("Failed to save clicked notification.", e);
        }
      })(notificationClicked);

      // Start making REST API requests BEFORE self.clients.openWindow is called.
      // It will cause the service worker to stop on Chrome for Android when site is added to the home screen.
      const { deviceId } = await database().getSubscription();
      const convertedAPIRequests = this.sendConvertedAPIRequests(appId, deviceId, notificationData, deviceType);

      /*
       Check if we can focus on an existing tab instead of opening a new url.
       If an existing tab with exactly the same URL already exists, then this existing tab is focused instead of
       an identical new tab being created. With a special setting, any existing tab matching the origin will
       be focused instead of an identical new tab being created.
       */
      const activeClients = await this.getActiveClients();
      let doNotOpenLink = false;
      for (const client of activeClients) {
        let clientUrl = client.url;
        if ((client as any).isSubdomainIframe) {
          const lastKnownHostUrl = await database().get<string>('Options', 'lastKnownHostUrl');
          // TODO: clientUrl is being overwritten by defaultUrl and lastKnownHostUrl.
          //       Should only use clientUrl if it is not null.
          //       Also need to decide which to use over the other.
          clientUrl = lastKnownHostUrl;
          if (!lastKnownHostUrl) {
            clientUrl = await database().get<string>('Options', 'defaultUrl');
          }
        }
        let clientOrigin = '';
        try {
          clientOrigin = new URL(clientUrl).origin;
        } catch (e) {
          conditionalLog().error(`Failed to get the HTTP site's actual origin:`, e);
        }
        let launchOrigin = null;
        try {
          // Check if the launchUrl is valid; it can be null
          launchOrigin = new URL(launchUrl).origin;
        } catch (e) {}

        if ((notificationClickHandlerMatch === 'exact' && clientUrl === launchUrl) ||
          (notificationClickHandlerMatch === 'origin' && clientOrigin === launchOrigin)) {
          if ((client['isSubdomainIframe'] && clientUrl === launchUrl) ||
              (!client['isSubdomainIframe'] && client.url === launchUrl) ||
            (notificationClickHandlerAction === 'focus' && clientOrigin === launchOrigin)) {
            workerMessenger.unicast(WorkerMessengerCommand.NotificationClicked, notificationData, client);
              try {
                if (client instanceof WindowClient)
                  await client.focus();
              } catch (e) {
                conditionalLog().error("Failed to focus:", client, e);
              }
          } else {
            /*
            We must focus first; once the client navigates away, it may not be on a domain the same domain, and
            the client ID may change, making it unable to focus.

            client.navigate() is available on Chrome 49+ and Firefox 50+.
             */
            if (client['isSubdomainIframe']) {
              try {
                conditionalLog().debug('Client is subdomain iFrame. Attempting to focus() client.');
                if (client instanceof WindowClient)
                  await client.focus();
              } catch (e) {
                conditionalLog().error("Failed to focus:", client, e);
              }
              if (notificationOpensLink) {
                conditionalLog().debug(`Redirecting HTTP site to ${launchUrl}.`);
                await database().put("NotificationOpened", { url: launchUrl, data: notificationData, timestamp: Date.now() });
                workerMessenger.unicast(WorkerMessengerCommand.RedirectPage, launchUrl, client);
              } else {
                conditionalLog().debug('Not navigating because link is special.');
              }
            }
            else if (client instanceof WindowClient && client.navigate) {
              try {
                conditionalLog().debug('Client is standard HTTPS site. Attempting to focus() client.');
                if (client instanceof WindowClient)
                  await client.focus();
              } catch (e) {
                conditionalLog().error("Failed to focus:", client, e);
              }
              try {
                if (notificationOpensLink) {
                  conditionalLog().debug(`Redirecting HTTPS site to (${launchUrl}).`);
                  await database().put("NotificationOpened", { url: launchUrl, data: notificationData, timestamp: Date.now() });
                  await client.navigate(launchUrl);
                } else {
                  conditionalLog().debug('Not navigating because link is special.');
                }
              } catch (e) {
                conditionalLog().error("Failed to navigate:", client, launchUrl, e);
              }
            } else {
              // If client.navigate() isn't available, we have no other option but to open a new tab to the URL.
              await database().put("NotificationOpened", { url: launchUrl, data: notificationData, timestamp: Date.now() });
              await this.openUrl(launchUrl);
            }
          }
          doNotOpenLink = true;
          break;
        }
      }

      if (notificationOpensLink && !doNotOpenLink) {
        await database().put("NotificationOpened", { url: launchUrl, data: notificationData, timestamp: Date.now() });
        await this.openUrl(launchUrl);
      }
      if (saveNotificationClickedPromise) {
        await saveNotificationClickedPromise;
      }

      return await convertedAPIRequests;
    },
  }
}

