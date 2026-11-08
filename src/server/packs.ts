import type { PackSummary, RoomKind } from '../shared/types.js';

export type PackBot = { name: string; role: string; brief: string };
export type PackRoom = { name: string; kind: RoomKind };
export type Pack = {
  id: string;
  name: string;
  mission: string;
  accent: string;
  rooms: PackRoom[];
  bots: PackBot[];
};

export const PACKS: Pack[] = [
  {
    id: 'qualite',
    name: 'Équipe Qualité',
    mission: 'Relire les parcours et noter les écarts, sans modifier le produit.',
    accent: '#1f6f64',
    rooms: [
      { name: 'Table de relecture', kind: 'revue' },
      { name: 'Paillasse des cas', kind: 'labo' },
    ],
    bots: [
      {
        name: 'Brume',
        role: 'Relecture',
        brief: 'Relire un parcours et lister les zones floues. Ne pas modifier le produit.',
      },
      {
        name: 'Cale',
        role: 'Cas limites',
        brief: 'Préparer des cas synthétiques. Ne jamais utiliser de données de compte.',
      },
      {
        name: 'Rive',
        role: 'Compte-rendu',
        brief: 'Rédiger les écarts observés, avec la source de chaque constat.',
      },
    ],
  },
  {
    id: 'developpement',
    name: 'Équipe Développement',
    mission: 'Découper, proposer et relire. Aucune mise en production depuis ces fiches.',
    accent: '#b85a2a',
    rooms: [
      { name: 'Établi', kind: 'atelier' },
      { name: 'Coin revue', kind: 'revue' },
    ],
    bots: [
      {
        name: 'Trame',
        role: 'Découpage',
        brief: 'Découper une demande en étapes vérifiables, sans écrire le correctif.',
      },
      {
        name: 'Goujon',
        role: 'Correctif',
        brief: 'Proposer un correctif et les essais qui le tiennent. Ne pas l’appliquer seul.',
      },
      {
        name: 'Lisière',
        role: 'Relecture de diff',
        brief: 'Relire un diff et signaler les risques. Ne pas fusionner.',
      },
    ],
  },
  {
    id: 'diffusion',
    name: 'Équipe Diffusion',
    mission: 'Préparer des messages. Rien n’est envoyé sans un accord explicite.',
    accent: '#3d5a8a',
    rooms: [
      { name: 'Table éditoriale', kind: 'diffusion' },
      { name: 'Salon calme', kind: 'salon' },
    ],
    bots: [
      {
        name: 'Bandeau',
        role: 'Brouillons',
        brief: 'Préparer des brouillons. Ne rien envoyer ni publier.',
      },
      {
        name: 'Feutre',
        role: 'Calendrier',
        brief: 'Tenir le calendrier local des sujets. Ne pas contacter l’extérieur.',
      },
      {
        name: 'Marges',
        role: 'Sources',
        brief: 'Vérifier que chaque chiffre cité a une source déjà présente dans l’atelier.',
      },
    ],
  },
];

export function packSummaries(): PackSummary[] {
  return PACKS.map((pack) => ({
    id: pack.id,
    name: pack.name,
    mission: pack.mission,
    accent: pack.accent,
    rooms: pack.rooms.length,
    bots: pack.bots.length,
  }));
}

export function packById(id: string): Pack | undefined {
  return PACKS.find((pack) => pack.id === id);
}

export function packMarkdown(pack: Pack): string {
  const rooms = pack.rooms.map((room) => `- ${room.name} (${room.kind})`).join('\n');
  const bots = pack.bots.map((bot) => `### ${bot.name} — ${bot.role}\n${bot.brief}`).join('\n\n');
  return `# Consigne Bot Cockpit — ${pack.name}

> Ceci est un texte à copier. Créer les fiches dans Bot Cockpit n’installe aucun bot et n’exécute aucun code.
> Aucun compte n’est modifié. Les rôles ci-dessous sont des consignes locales, pas des agents déjà en service.

## Mission
${pack.mission}

## Salles
${rooms}

## Rôles
${bots}

## Ce que cette consigne ne fait pas
- Elle ne se connecte pas à un compte.
- Elle ne crée pas de routine, de webhook, ni de serveur MCP.
- Elle ne fournit pas d’usage, de coût, ni d’économie.
`;
}
