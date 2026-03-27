export type FakeDiscordMessage = Readonly<{
  channelId: string;
  content: string;
}>;

export class FakeDiscordClient {
  private readonly sentMessages: FakeDiscordMessage[] = [];

  send(channelId: string, content: string): void {
    this.sentMessages.push({ channelId, content });
  }

  getMessages(): readonly FakeDiscordMessage[] {
    return this.sentMessages;
  }
}
