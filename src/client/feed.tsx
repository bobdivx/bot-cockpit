import type { Bot, BotStatus, HistoryEntry, Signal } from '../shared/types';
import { BOT_STATUSES } from '../shared/types';
import { dayKey, dayLabel, formatTime, STATUS_LABEL, sourceLabel } from './format';
import { Badge, StatusPill } from './ui';

export type FeedItem = {
  id: string;
  at: string;
  botId: string | null;
  botKey: string;
  kind: 'status' | 'event' | 'manual';
  status: BotStatus | null;
  title: string;
  detail: string;
  source: string;
  partialTokens: boolean;
  isDemo: boolean;
};

export function fromSignal(signal: Signal): FeedItem {
  return {
    id: `s-${signal.id}`,
    at: signal.occurredAt,
    botId: signal.botId,
    botKey: signal.reportedBotKey,
    kind: signal.kind,
    status: signal.kind === 'status' ? signal.status : null,
    title: signal.kind === 'status' ? 'Statut signalé' : signal.name,
    detail: signal.detail,
    source: signal.reportedSource,
    partialTokens: signal.partialTokens,
    isDemo: signal.isDemo,
  };
}

export function fromHistory(entry: HistoryEntry): FeedItem {
  return {
    id: `h-${entry.id}`,
    at: entry.occurredAt,
    botId: entry.botId,
    botKey: '',
    kind: 'manual',
    status: BOT_STATUSES.includes(entry.status) ? entry.status : null,
    title: STATUS_LABEL[entry.status] ?? entry.status,
    detail: entry.note,
    source: entry.source,
    partialTokens: false,
    isDemo: false,
  };
}

export function Feed({
  items,
  bots,
  showBot = true,
  grouped = true,
  empty,
}: {
  items: FeedItem[];
  bots: Bot[];
  showBot?: boolean;
  grouped?: boolean;
  empty?: preact.ComponentChildren;
}) {
  if (items.length === 0) return <>{empty ?? null}</>;
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
  const groups: Array<{ key: string; items: FeedItem[] }> = [];
  for (const item of sorted) {
    const key = grouped ? dayKey(item.at) : 'all';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return (
    <div class="feed">
      {groups.map((group) => (
        <div key={group.key} class="feed-group">
          {grouped && <h3 class="feed-day">{dayLabel(group.key)}</h3>}
          <ol class="feed-list">
            {group.items.map((item) => {
              const bot = item.botId ? bots.find((candidate) => candidate.id === item.botId) : null;
              const who = bot?.name ?? item.botKey ?? 'Bot inconnu';
              return (
                <li key={item.id} class={`feed-item k-${item.kind}`}>
                  <time class="feed-time" dateTime={item.at}>
                    {formatTime(item.at)}
                  </time>
                  <span class="feed-dot" aria-hidden="true" />
                  <div class="feed-body">
                    <p class="feed-title">
                      {showBot &&
                        (bot ? (
                          <a class="feed-bot" href={`#/bots/${bot.id}`}>
                            {who}
                          </a>
                        ) : (
                          <span class="feed-bot">{who}</span>
                        ))}
                      {item.status ? (
                        <StatusPill status={item.status} />
                      ) : (
                        <span class="feed-what">{item.title}</span>
                      )}
                    </p>
                    {item.detail && <p class="feed-detail">{item.detail}</p>}
                    <p class="feed-meta">
                      {item.kind === 'manual' ? 'Changement manuel' : sourceLabel(item.source)}
                      {item.partialTokens && (
                        <>
                          {' · '}
                          <Badge tone="info">jetons déclarés</Badge>
                        </>
                      )}
                      {item.isDemo && (
                        <>
                          {' · '}
                          <Badge tone="warn">démo</Badge>
                        </>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}
