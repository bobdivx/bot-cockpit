import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bot, Room, Signal, Team } from '../shared/types';
import type { CampusView } from './campus';

export type SceneApi = {
  resetCamera: () => void;
  focusRoom: (id: string) => void;
  enterSelected: () => void;
};

export function OfficeScene({
  rooms,
  teams,
  bots,
  signals,
  demo,
  selected,
  onSelect,
  onReady,
}: {
  rooms: Room[];
  teams: Team[];
  bots: Bot[];
  signals: Signal[];
  demo: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onReady?: (api: SceneApi | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CampusView | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const snap = useRef({ rooms, teams, bots, signals, demo, selected });
  snap.current = { rooms, teams, bots, signals, demo, selected };
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
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
      readyRef.current?.({
        resetCamera: () => campus?.resetCamera(),
        focusRoom: (id) => campus?.focusRoom(id),
        enterSelected: () => campus?.enterSelected(),
      });
    });
    return () => {
      cancelled = true;
      readyRef.current?.(null);
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

  return (
    <div class="scene-stage" role="application" aria-label="Bureau isométrique">
      <div class="scene-host" ref={host} />
      {!webgl && (
        <p class="scene-note" style="position:absolute;inset:16px;max-width:none">
          WebGL est indisponible. La liste compacte reste utilisable.
        </p>
      )}
      <p class="scene-note motion-note">{note}</p>
    </div>
  );
}
