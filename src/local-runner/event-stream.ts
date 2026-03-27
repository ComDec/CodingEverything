import type { ServerResponse } from 'node:http';
import type { EventRecord } from '../shared/db/repositories.js';

type Subscriber = {
  sessionId: string;
  response: ServerResponse;
};

export function createEventStreamBroker() {
  const subscribers = new Set<Subscriber>();

  return {
    publish(record: EventRecord): void {
      for (const subscriber of subscribers) {
        if (subscriber.sessionId !== record.sessionId) {
          continue;
        }

        writeEvent(subscriber.response, record);
      }
    },

    subscribe(input: {
      sessionId: string;
      response: ServerResponse;
      backlog: EventRecord[];
    }): void {
      const subscriber: Subscriber = {
        sessionId: input.sessionId,
        response: input.response
      };

      input.response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      for (const record of input.backlog) {
        writeEvent(input.response, record);
      }

      subscribers.add(subscriber);

      input.response.on('close', () => {
        subscribers.delete(subscriber);
      });
    }
  };
}

function writeEvent(response: ServerResponse, record: EventRecord): void {
  response.write(`id: ${record.id}\n`);
  response.write(`event: ${record.event.type}\n`);
  response.write(`data: ${JSON.stringify(record.event)}\n\n`);
}
