import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  private isExpoPushToken(token: string): boolean {
    return /^ExponentPushToken\[[^\]]+\]$/.test(token) || /^ExpoPushToken\[[^\]]+\]$/.test(token);
  }

  async sendPush(expoPushToken: string | null | undefined, title: string, body: string, data?: Record<string, any>) {
    if (!expoPushToken) return;
    if (!this.isExpoPushToken(expoPushToken)) {
      this.logger.warn(`Skipping invalid push token format: ${expoPushToken}`);
      return;
    }

    const message = {
      to: expoPushToken,
      sound: 'default',
      title,
      body,
      data: data ?? {},
      priority: 'high',
      channelId: 'default',
    };

    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(message),
      });
      const result = await res.json();

      if (!res.ok || result?.data?.status === 'error' || result?.errors?.length) {
        this.logger.warn(`Expo push API rejected notification for ${expoPushToken}: ${JSON.stringify(result)}`);
        return;
      }

      this.logger.log(`Push sent to ${expoPushToken}: ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Failed to send push to ${expoPushToken}:`, err);
    }
  }
}

