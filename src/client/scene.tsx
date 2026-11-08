import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bot, Room, Signal, Team } from '../shared/types';
import type { CampusView } from './campus';
import { STATUS_LABEL, signalLabel } from './format';

export function OfficeScene({
  rooms,
  teams,
  bots,
  signals,
  demo,
  selected,
  onSelect,
}: {
  rooms: Room[];
  teams: Team[];
  bots: Bot[];
  signals: Signal[];
  demo: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CampusView | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const snap = useRef({ rooms, teams, bots, signals, demo, selected });
  snap.current = { rooms, teams, bots, signals, demo, selected };
  const [webgl, setWebgl] = useState(true);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let campus: CampusView | null = null;
    let cancelled = false;
    void import('./campus').then(({ CampusView: View }) => {
      if (cancelled || !node.isConnected) return;
      const initialReduced =
        document.documentElement.dataset.motion === 'reduce' ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      campus = new View(node, (id) => selectRef.current(id), initialReduced);
      if (!campus.ok) {
        setWebgl(false);
        campus.dispose();
        campus = null;
        return;
      }
      view.current = campus;
      const current = snap.current;
      campus.setSnapshot(current);
      campus.setSelected(current.selected);
    });
    return () => {
      cancelled = true;
      campus?.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => {
      const manual = document.documentElement.dataset.motion === 'reduce';
      const next = manual || media.matches;
      setReduced(next);
      view.current?.setReduced(next);
    };
    read();
    media.addEventListener('change', read);
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-motion'],
    });
    return () => {
      media.removeEventListener('change', read);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    view.current?.setSnapshot({ rooms, teams, bots, signals, demo });
  }, [rooms, teams, bots, signals, demo]);

  useEffect(() => {
    view.current?.setSelected(selected);
  }, [selected]);

  const note = reduced
    ? 'Mouvement réduit : poses fixes, selon le dernier signal.'
    : demo
      ? 'Trajet fictif entre les fiches de démonstration. Les poses suivent les statuts.'
      : 'Le mouvement suit le statut observé. Un signal ancien fige le personnage.';
  const selectedBot = bots.find((bot) => bot.id === selected) ?? null;
  const activeRoom = selectedBot?.roomId ?? null;

  return (
    <div class="scene-stage" role="application" aria-label="Bureau isométrique">
      <div class="scene-host" ref={host} />
      {!webgl && (
        <p class="scene-note" style="position:absolute;inset:16px;max-width:none">
          WebGL est indisponible. La liste compacte reste utilisable.
        </p>
      )}
      <nav class="floor-nav" aria-label="Salles">
        <button
          type="button"
          class={!activeRoom ? 'on' : ''}
          onClick={() => view.current?.resetCamera()}
        >
          <b>Tout le plateau</b>
          <small>
            {rooms.length} salle{rooms.length > 1 ? 's' : ''}
          </small>
        </button>
        {rooms.map((room) => {
          const team = teams.find((item) => item.id === room.teamId);
          return (
            <button
              key={room.id}
              type="button"
              class={activeRoom === room.id ? 'on' : ''}
              style={`--team:${team?.accent ?? '#8eb7ff'}`}
              onClick={() => view.current?.focusRoom(room.id)}
            >
              <b>{room.name}</b>
              <small>{team?.name ?? 'Sans équipe'}</small>
            </button>
          );
        })}
      </nav>
      <div class="scene-hud">
        <p class="scene-note">
          {selectedBot
            ? `${selectedBot.name} · ${STATUS_LABEL[selectedBot.status]} · ${signalLabel(selectedBot)}`
            : 'Sélectionnez un personnage pour lire son dernier signal.'}
          <span>{note}</span>
        </p>
        <div class="chips scene-actions">
          <button class="btn small" type="button" onClick={() => view.current?.resetCamera()}>
            Recadrer
          </button>
          <button class="btn small" type="button" onClick={() => view.current?.enterSelected()}>
            Approcher
          </button>
        </div>
      </div>
    </div>
  );
}
