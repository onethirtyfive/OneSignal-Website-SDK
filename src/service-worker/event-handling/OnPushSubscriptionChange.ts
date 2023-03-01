import Utils from "../../context/shared/utils/Utils";
import { ConfigHelper } from "../../helpers/ConfigHelper";
import ContextSW from "../../models/ContextSW";
import { PushDeviceRecord } from "../../models/PushDeviceRecord";
import { RawPushSubscription } from "../../models/RawPushSubscription";
import { SubscriptionStateKind } from "../../models/SubscriptionStateKind";
import { SubscriptionStrategyKind } from "../../models/SubscriptionStrategyKind";
import OneSignalApiSW from "../../OneSignalApiSW";
import { OSServiceWorkerRuntime } from "../OSServiceWorkerRuntime"

export interface OSServiceWorkerEventOnPushSubscriptionChange {
  onPushSubscriptionChange(event: PushSubscriptionChangeEvent): Promise<void>;
}

export const mk: (
  (runtime: OSServiceWorkerRuntime) => OSServiceWorkerEventOnPushSubscriptionChange
) = function({ conditionalLog, getAppId, database, }) {
  return {
    onPushSubscriptionChange: async function(event: PushSubscriptionChangeEvent): Promise<void> {
      conditionalLog().debug(`Called %conPushSubscriptionChange(${JSON.stringify(event, null, 4)}):`, Utils.getConsoleStyle('code'), event);

      const appId = await getAppId();
      if (!appId) {
        // Without an app ID, we can't make any calls
        return;
      }
      const appConfig = await ConfigHelper.getAppConfig({ appId }, OneSignalApiSW.downloadServerAppConfig);
      if (!appConfig) {
        // Without a valid app config (e.g. deleted app), we can't make any calls
        return;
      }
      const context = new ContextSW(appConfig);

      // Get our current device ID
      let deviceIdExists: boolean;
      {
        let { deviceId } = await database().getSubscription();
        deviceIdExists = !!deviceId;
        if (!deviceIdExists && event.oldSubscription) {
          // We don't have the device ID stored, but we can look it up from our old subscription
          deviceId = await OneSignalApiSW.getUserIdFromSubscriptionIdentifier(
            appId,
            PushDeviceRecord.prototype.getDeliveryPlatform(),
            event.oldSubscription.endpoint
          );

          // Store the device ID, so it can be looked up when subscribing
          const subscription = await database().getSubscription();
          subscription.deviceId = deviceId;
          await database().setSubscription(subscription);
        }
        deviceIdExists = !!deviceId;
      }

      // Get our new push subscription
      let rawPushSubscription: RawPushSubscription | null;

      // Set it initially by the provided new push subscription
      const providedNewSubscription = event.newSubscription;
      if (providedNewSubscription) {
        rawPushSubscription = RawPushSubscription.setFromW3cSubscription(providedNewSubscription);
      } else {
        // Otherwise set our push registration by resubscribing
        try {
          rawPushSubscription = await context.subscriptionManager.subscribe(SubscriptionStrategyKind.SubscribeNew);
        } catch (e) {
          rawPushSubscription = null;
        }
      }
      const hasNewSubscription = !!rawPushSubscription;

      if (!deviceIdExists && !hasNewSubscription) {
        await database().remove('Ids', 'userId');
        await database().remove('Ids', 'registrationId');
      } else {
        /*
          Determine subscription state we should set new record to.

          If the permission is revoked, we should set the subscription state to permission revoked.
         */
        let subscriptionState: null | SubscriptionStateKind = null;
        const pushPermission = Notification.permission;

        if (pushPermission !== "granted") {
          subscriptionState = SubscriptionStateKind.PermissionRevoked;
        } else if (!rawPushSubscription) {
          /*
            If it's not a permission revoked issue, the subscription expired or was revoked by the
            push server.
           */
          subscriptionState = SubscriptionStateKind.PushSubscriptionRevoked;
        }

        // rawPushSubscription may be null if no push subscription was retrieved
        await context.subscriptionManager.registerSubscription(
          // FIXME: tighten contract types in `registerSubscription`
          rawPushSubscription!,
          subscriptionState!
        );
      }
    },
  }
}

