import Utils from "../../context/shared/utils/Utils";
import { WorkerMessengerCommand } from "../../libraries/WorkerMessenger";
import { NotificationReceived } from "../../models/Notification";
import OneSignalUtils from "../../utils/OneSignalUtils";
import { OSServiceWorkerEventHandling } from "../OSServiceWorkerEventHandling";
import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime"

export interface OSServiceWorkerEventOnPushReceived {
  isValidPushPayload(rawData: any): boolean;
  parseOrFetchNotifications(event: any): Promise<Array<any>>;
  buildStructuredNotificationObject(rawNotification: any): any;
  _getTitle(): Promise<unknown>;
  ensureImageResourceHttps(imageUrl: string): string | null;
  ensureNotificationResourcesHttps(notification: any): void;
  displayNotification(notification: any, overrides?: any): Promise<void>;
  onPushReceived(event: PushEvent): void;
}

export const mk: (
  (runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventOnPushReceived
) = function({ conditionalLog, workerMessenger, getAppId, database, providedSelf }) {
  return {
    /**
    * Returns true if the raw data payload is a OneSignal push message in the format of the new web push protocol.
    * Otherwise returns false.
    * @param rawData The raw PushMessageData from the push event's event.data, not already parsed to JSON.
    */
    isValidPushPayload: function(rawData: any): boolean {
      try {
        const payload = rawData.json();
        if (payload &&
          payload.custom &&
          payload.custom.i &&
          OneSignalUtils.isValidUuid(payload.custom.i)) {
          return true;
        } else {
          conditionalLog().debug('isValidPushPayload: Valid JSON but missing notification UUID:', payload);
          return false;
        }
      } catch (e) {
        conditionalLog().debug('isValidPushPayload: Parsing to JSON failed with:', e);
        return false;
      }
    },

    /**
    * Returns an array of raw notification objects, read from the event.data.payload property
    * @param event
    * @returns An array of notifications. The new web push protocol will only ever contain one notification, however
    * an array is returned for backwards compatibility with the rest of the service worker plumbing.
    */
    parseOrFetchNotifications: function(
      this: OSServiceWorkerEventHandling,
      event: any
    ): Promise<Array<string>> {
        if (!event || !event.data) {
      return Promise.reject("Missing event.data on push payload!");
      }

      const isValidPayload = this.isValidPushPayload(event.data);
      if (isValidPayload) {
        conditionalLog().debug("Received a valid encrypted push payload.");
        return Promise.resolve([event.data.json()]);
      }

      /*
      We received a push message payload from another service provider or a malformed
      payload. The last received notification will be displayed.
      */
      return Promise.reject(`Unexpected push message payload received: ${event.data}`);
    },

    /**
    * Constructs a structured notification object from the raw notification fetched from OneSignal's server. This
    * object is passed around from event to event, and is also returned to the host page for notification event details.
    * Constructed in onPushReceived, and passed along to other event handlers.
    * @param rawNotification The raw notification JSON returned from OneSignal's server.
    */
    buildStructuredNotificationObject: function(rawNotification: any) {
      const notification: any = {
        id: rawNotification.custom.i,
        heading: rawNotification.title,
        content: rawNotification.alert,
        data: rawNotification.custom.a,
        url: rawNotification.custom.u,
        rr: rawNotification.custom.rr, // received receipts
        icon: rawNotification.icon,
        image: rawNotification.image,
        tag: rawNotification.tag,
        badge: rawNotification.badge,
        vibrate: rawNotification.vibrate
      };

      // Add action buttons
      if (rawNotification.o) {
        notification.buttons = [];
        for (const rawButton of rawNotification.o) {
          notification.buttons.push({
            action: rawButton.i,
            title: rawButton.n,
            icon: rawButton.p,
            url: rawButton.u
          });
        }
      }
      return Utils.trimUndefined(notification);
    },

    _getTitle: function(): Promise<unknown> {
      return new Promise(resolve => {
      Promise.all([database().get('Options', 'defaultTitle'), database().get('Options', 'pageTitle')])
        .then(([defaultTitle, pageTitle]) => {
          if (defaultTitle !== null) {
            resolve(defaultTitle);
          }
          else if (pageTitle != null) {
            resolve(pageTitle);
          }
          else {
            resolve('');
          }
        });
      });
    },

    /**
    * Given an image URL, returns a proxied HTTPS image using the https://images.weserv.nl service.
    * For a null image, returns null so that no icon is displayed.
    * If the image protocol is HTTPS, or origin contains localhost or starts with 192.168.*.*, we do not proxy the image.
    * @param imageUrl An HTTP or HTTPS image URL.
    */
    ensureImageResourceHttps: function(imageUrl: string): string | null {
      if (imageUrl) {
        try {
          const parsedImageUrl = new URL(imageUrl);
          if (parsedImageUrl.hostname === 'localhost' ||
            parsedImageUrl.hostname.indexOf('192.168') !== -1 ||
            parsedImageUrl.hostname === '127.0.0.1' ||
            parsedImageUrl.protocol === 'https:') {
            return imageUrl;
          }
          if (parsedImageUrl.hostname === 'i0.wp.com' ||
            parsedImageUrl.hostname === 'i1.wp.com' ||
            parsedImageUrl.hostname === 'i2.wp.com' ||
            parsedImageUrl.hostname === 'i3.wp.com') {
            /* Their site already uses Jetpack, just make sure Jetpack is HTTPS */
            return `https://${parsedImageUrl.hostname}${parsedImageUrl.pathname}`;
          }
          /* HTTPS origin hosts can be used by prefixing the hostname with ssl: */
          const replacedImageUrl = parsedImageUrl.host + parsedImageUrl.pathname;
          return `https://i0.wp.com/${replacedImageUrl}`;
        } catch (e) { return null; }
      } else return null;
    },

    /**
    * Given a structured notification object, HTTPS-ifies the notification icons and action button icons, if they exist.
    */
    ensureNotificationResourcesHttps: function(
      this: OSServiceWorkerEventHandling,
      notification: any
    ): void {
      if (notification) {
        if (notification.icon) {
          notification.icon = this.ensureImageResourceHttps(notification.icon);
        }
        if (notification.image) {
          notification.image = this.ensureImageResourceHttps(notification.image);
        }
        if (notification.buttons && notification.buttons.length > 0) {
          for (const button of notification.buttons) {
            if (button.icon) {
              button.icon = this.ensureImageResourceHttps(button.icon);
            }
          }
        }
      }
    },

    /**
    * Actually displays a visible notification to the user.
    * Any event needing to display a notification calls this so that all the display options can be centralized here.
    * @param notification A structured notification object.
    */
    displayNotification: async function(
      this: OSServiceWorkerEventHandling,
      notification: any, overrides?: any
    ): Promise<void> {
      conditionalLog().debug(`Called %cdisplayNotification(${JSON.stringify(notification, null, 4)}):`, Utils.getConsoleStyle('code'), notification);

      // Use the default title if one isn't provided
      const defaultTitle = await this._getTitle() as string;
      // Use the default icon if one isn't provided
      const defaultIcon = await database().get('Options', 'defaultIcon');
      // Get option of whether we should leave notification displaying indefinitely
      const persistNotification = await database().get('Options', 'persistNotification');
      // Get app ID for tag value
      const appId = await getAppId();

      notification.heading = notification.heading ? notification.heading : defaultTitle;
      notification.icon = notification.icon ? notification.icon : (defaultIcon ? defaultIcon : undefined);

      const extra: any = {};
      extra.tag = notification.tag || appId;
      extra.persistNotification = persistNotification !== false;

      // Allow overriding some values
      if (!overrides)
      overrides = {};
      notification = { ...notification, ...overrides };

      this.ensureNotificationResourcesHttps(notification);

      const notificationOptions = {
        body: notification.content,
        icon: notification.icon,
        /*
        On Chrome 56, a large image can be displayed:
        https://bugs.chromium.org/p/chromium/issues/detail?id=614456
        */
        image: notification.image,
        /*
        On Chrome 44+, use this property to store extra information which
        you can read back when the notification gets invoked from a
        notification click or dismissed event. We serialize the
        notification in the 'data' field and read it back in other events.
        See:
        https://developers.google.com/web/updates/2015/05/notifying-you-of-changes-to-notifications?hl=en
        */
        data: notification,
        /*
        On Chrome 48+, action buttons show below the message body of the
        notification. Clicking either button takes the user to a link. See:
        https://developers.google.com/web/updates/2016/01/notification-actions
        */
        actions: notification.buttons,
        /*
        Tags are any string value that groups notifications together. Two
        or notifications sharing a tag replace each other.
        */
        tag: extra.tag,
        /*
        On Chrome 47+ (desktop), notifications will be dismissed after 20
        seconds unless requireInteraction is set to true. See:
        https://developers.google.com/web/updates/2015/10/notification-requireInteractiom
        */
        requireInteraction: extra.persistNotification,
        /*
        On Chrome 50+, by default notifications replacing
        identically-tagged notifications no longer vibrate/signal the user
        that a new notification has come in. This flag allows subsequent
        notifications to re-alert the user. See:
        https://developers.google.com/web/updates/2016/03/notifications
        */
        renotify: true,
        /*
        On Chrome 53+, returns the URL of the image used to represent the
        notification when there is not enough space to display the
        notification itprovidedSelf.

        The URL of an image to represent the notification when there is not
        enough space to display the notification itself such as, for
        example, the Android Notification Bar. On Android devices, the
        badge should accommodate devices up to 4x resolution, about 96 by
        96 px, and the image will be automatically masked.
        */
        badge: notification.badge,
        /*
        A vibration pattern to run with the display of the notification. A
        vibration pattern can be an array with as few as one member. The
        values are times in milliseconds where the even indices (0, 2, 4,
        etc.) indicate how long to vibrate and the odd indices indicate how
        long to pause. For example [300, 100, 400] would vibrate 300ms,
        pause 100ms, then vibrate 400ms.
        */
        vibrate: notification.vibrate
      };

      return providedSelf.registration.showNotification(notification.heading, notificationOptions);
    },

    /**
    * Occurs when a push message is received.
    * This method handles the receipt of a push signal on all web browsers except Safari, which uses the OS to handle
    * notifications.
    */
    onPushReceived: function(
      this: OSServiceWorkerEventHandling,
      event: PushEvent
    ): void {
      conditionalLog().debug(`Called %conPushReceived(${JSON.stringify(event, null, 4)}):`, Utils.getConsoleStyle('code'), event);

      event.waitUntil(
        this.parseOrFetchNotifications(event)
          .then(async (notifications: any) => {
            //Display push notifications in the order we received them
            const notificationEventPromiseFns = [];
            const notificationReceivedPromises: Promise<void>[] = [];
            const appId = await getAppId();

            for (const rawNotification of notifications) {
              conditionalLog().debug('Raw Notification from OneSignal:', rawNotification);
              const notification = this.buildStructuredNotificationObject(rawNotification);

              const notificationReceived: NotificationReceived = {
                notificationId: notification.id,
                appId,
                url: notification.url,
                timestamp: new Date().getTime(),
              };
              notificationReceivedPromises.push(database().put("NotificationReceived", notificationReceived));
              // TODO: decide what to do with all the notif received promises
              // Probably should have it's own error handling but not blocking the rest of the execution?

              // Never nest the following line in a callback from the point of entering from retrieveNotifications
              notificationEventPromiseFns.push((async (notif: any) => {
                return this.displayNotification(notif)
                  .then(async () => {
                    return workerMessenger.broadcast(WorkerMessengerCommand.NotificationDisplayed, notif).catch(e => conditionalLog().error(e));
                  })
                  .then(() => this.executeWebhooks('notification.displayed', notif)
                    .then(() => this.sendConfirmedDelivery(notif)).catch(e => conditionalLog().error(e)));
              }).bind(null, notification));
            }

            return notificationEventPromiseFns.reduce((p, fn) => {
              return p = p.then(fn);
            }, Promise.resolve());
          })
          .catch(e => {
            conditionalLog().debug('Failed to display a notification:', e);
            if (this.UNSUBSCRIBED_FROM_NOTIFICATIONS) {
              conditionalLog().debug('Because we have just unsubscribed from notifications, we will not show anything.');
            }
            return undefined;
          })
      );
    },
  }
}

