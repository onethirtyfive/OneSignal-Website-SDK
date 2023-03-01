import { ConfigHelper } from "../helpers/ConfigHelper"
import { WorkerMessengerCommand } from "../libraries/WorkerMessenger"
import ContextSW from "../models/ContextSW"
import { PageVisibilityResponse } from "../models/Session"
import { SubscriptionStrategyKind } from "../models/SubscriptionStrategyKind"
import { UnsubscriptionStrategy } from "../models/UnsubscriptionStrategy"
import OneSignalApiSW from "../OneSignalApiSW"
import { OSServiceWorkerRuntime } from "./OSServiceWorkerRuntime"

export type OSServiceWorkerMessageHandlers = {
  [K in WorkerMessengerCommand as string]?: (_: any) => void | Promise<void>
}

export interface FnMkMessageHandlingOptions {
  runtime: OSServiceWorkerRuntime;
}

type FnMkMessageHandlers = (options: FnMkMessageHandlingOptions) => OSServiceWorkerMessageHandlers

export const mkMessageHandlers: FnMkMessageHandlers = ({ runtime }) => {
  // Things we need from the runtime, available to message handlers.
  const {
    conditionalLog,
    providedSelf,
    database,
    workerMessenger,
    getAppId,
    environment,
    ConditionalLog
  } = runtime

  return {
    [WorkerMessengerCommand.WorkerVersion]: function(_: any) {
      conditionalLog().debug('[Service Worker] Received worker version message.');
      workerMessenger.broadcast(WorkerMessengerCommand.WorkerVersion, environment.version())
    },
    [WorkerMessengerCommand.Subscribe]: async function(appConfigBundle: any) {
      const appConfig = appConfigBundle;
      conditionalLog().debug('[Service Worker] Received subscribe message.');
      const context = new ContextSW(appConfig);
      const rawSubscription = await context.subscriptionManager.subscribe(SubscriptionStrategyKind.ResubscribeExisting);
      const subscription = await context.subscriptionManager.registerSubscription(rawSubscription);
      workerMessenger.broadcast(WorkerMessengerCommand.Subscribe, subscription.serialize());
    },
    [WorkerMessengerCommand.SubscribeNew]: async function(appConfigBundle: any) {
      const appConfig = appConfigBundle;
      conditionalLog().debug('[Service Worker] Received subscribe new message.');
      const context = new ContextSW(appConfig);
      const rawSubscription = await context.subscriptionManager.subscribe(SubscriptionStrategyKind.SubscribeNew);
      const subscription = await context.subscriptionManager.registerSubscription(rawSubscription);
      workerMessenger.broadcast(WorkerMessengerCommand.SubscribeNew, subscription.serialize());
    },
    [WorkerMessengerCommand.AmpSubscriptionState]: async function(_appConfigBundle: any) {
      conditionalLog().debug('[Service Worker] Received AMP subscription state message.');
      const pushSubscription = await providedSelf.registration.pushManager.getSubscription();
      if (!pushSubscription) {
        await workerMessenger.broadcast(WorkerMessengerCommand.AmpSubscriptionState, false);
      } else {
        const permission = await providedSelf.registration.pushManager.permissionState(pushSubscription.options);
        const { optedOut } = await database().getSubscription();
        const isSubscribed = !!pushSubscription && permission === "granted" && optedOut !== true;
        await workerMessenger.broadcast(WorkerMessengerCommand.AmpSubscriptionState, isSubscribed);
      }
    },
    [WorkerMessengerCommand.AmpSubscribe]: async function() {
      conditionalLog().debug('[Service Worker] Received AMP subscribe message.');
      const appId = await getAppId();
      const appConfig = await ConfigHelper.getAppConfig({ appId }, OneSignalApiSW.downloadServerAppConfig);
      const context = new ContextSW(appConfig);
      const rawSubscription = await context.subscriptionManager.subscribe(SubscriptionStrategyKind.ResubscribeExisting);
      const subscription = await context.subscriptionManager.registerSubscription(rawSubscription);
      await database().put('Ids', { type: 'appId', id: appId });
      workerMessenger.broadcast(WorkerMessengerCommand.AmpSubscribe, subscription.deviceId!);
    },
    [WorkerMessengerCommand.AmpUnsubscribe]: async function() {
      conditionalLog().debug('[Service Worker] Received AMP unsubscribe message.');
      const appId = await getAppId();
      const appConfig = await ConfigHelper.getAppConfig({ appId }, OneSignalApiSW.downloadServerAppConfig);
      const context = new ContextSW(appConfig);
      await context.subscriptionManager.unsubscribe(UnsubscriptionStrategy.MarkUnsubscribed);
      workerMessenger.broadcast(WorkerMessengerCommand.AmpUnsubscribe, null!);
    },
    [WorkerMessengerCommand.AreYouVisibleResponse]: async function(payload: PageVisibilityResponse) {
      conditionalLog().debug('[Service Worker] Received response for AreYouVisible', payload);
      if (!providedSelf.clientsStatus) { return; }

      const timestamp = payload.timestamp;
      if (providedSelf.clientsStatus.timestamp !== timestamp) { return; }

      providedSelf.clientsStatus.receivedResponsesCount++;
      if (payload.focused) {
        providedSelf.clientsStatus.hasAnyActiveSessions = true;
      }
    },
    [WorkerMessengerCommand.SetLogging]: async function(payload: {shouldLog: boolean}) {
      if (payload.shouldLog) {
        ConditionalLog.resetInstance(true)
      } else {
        ConditionalLog.resetInstance(false)
      }
    },
  }
}


