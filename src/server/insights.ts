import type { Insight, UsageRow, UsageSummary } from '../shared/types.js';

const BASE_WARNINGS = [
  'Les totaux de jetons ne sont pas un pourcentage de quota.',
  'Included, « - » et les textes non numériques sont des coûts inconnus, pas des zéros.',
  'Aucune économie n’est calculée.',
];

export function summarizeUsage(
  rows: UsageRow[],
  filters: UsageSummary['filters'],
  eventTokenSignals: number,
): UsageSummary {
  let unassigned = 0;
  let undated = 0;
  let tokenRows = 0;
  let missingTotal = 0;
  let input = 0;
  let inputSeen = false;
  let cache = 0;
  let cacheSeen = false;
  let output = 0;
  let outputSeen = false;
  let total = 0;
  let totalSeen = false;
  let costSum = 0;
  let costNumericRows = 0;
  let costIncludedRows = 0;
  let costUnknownRows = 0;
  const days = new Map<
    string,
    { rows: number; rowsWithTotal: number; totalTokens: number; cost: number; costSeen: boolean }
  >();
  const models = new Map<string, { rows: number; totalTokens: number }>();

  for (const row of rows) {
    if (!row.botId) unassigned += 1;
    if (!row.day) undated += 1;
    if (row.inputTokens != null) {
      input += row.inputTokens;
      inputSeen = true;
    }
    if (row.cacheTokens != null) {
      cache += row.cacheTokens;
      cacheSeen = true;
    }
    if (row.outputTokens != null) {
      output += row.outputTokens;
      outputSeen = true;
    }
    if (row.totalTokens != null) {
      total += row.totalTokens;
      totalSeen = true;
      tokenRows += 1;
    } else missingTotal += 1;
    if (row.costKind === 'numeric' && row.costValue != null) {
      costSum += row.costValue;
      costNumericRows += 1;
    } else if (row.costKind === 'included') costIncludedRows += 1;
    else costUnknownRows += 1;

    if (row.day) {
      const bucket = days.get(row.day) ?? {
        rows: 0,
        rowsWithTotal: 0,
        totalTokens: 0,
        cost: 0,
        costSeen: false,
      };
      bucket.rows += 1;
      if (row.totalTokens != null) {
        bucket.rowsWithTotal += 1;
        bucket.totalTokens += row.totalTokens;
      }
      if (row.costKind === 'numeric' && row.costValue != null) {
        bucket.cost += row.costValue;
        bucket.costSeen = true;
      }
      days.set(row.day, bucket);
    }
    const modelName = row.model || 'Modèle non renseigné';
    const modelBucket = models.get(modelName) ?? { rows: 0, totalTokens: 0 };
    modelBucket.rows += 1;
    if (row.totalTokens != null) modelBucket.totalTokens += row.totalTokens;
    models.set(modelName, modelBucket);
  }

  const byDay = [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => ({
      day,
      rows: bucket.rows,
      rowsWithTotal: bucket.rowsWithTotal,
      totalTokens: bucket.totalTokens,
      costNumericSum: bucket.costSeen ? bucket.cost : null,
    }));
  const byModel = [...models.entries()]
    .map(([model, bucket]) => ({ model, rows: bucket.rows, totalTokens: bucket.totalTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.rows - a.rows);
  const peak = byDay.reduce<{ day: string; tokens: number } | null>((best, day) => {
    if (!best || day.totalTokens > best.tokens) return { day: day.day, tokens: day.totalTokens };
    return best;
  }, null);

  return {
    filters,
    totals: {
      rows: rows.length,
      unassignedRows: unassigned,
      undatedRows: undated,
      tokenRows,
      missingTotalRows: missingTotal,
      inputTokens: inputSeen ? input : null,
      cacheTokens: cacheSeen ? cache : null,
      outputTokens: outputSeen ? output : null,
      totalTokens: totalSeen ? total : null,
      costNumericSum: costNumericRows > 0 ? costSum : null,
      costNumericRows,
      costIncludedRows,
      costUnknownRows,
    },
    byDay,
    byModel,
    models: [...models.keys()].filter((model) => model !== 'Modèle non renseigné').sort(),
    insights: buildInsights({
      rows: rows.length,
      unassigned,
      costIncludedRows,
      costUnknownRows,
      missingTotal,
      undated,
      peak,
      eventTokenSignals,
    }),
    warnings: warningsFor({
      rows: rows.length,
      costIncludedRows,
      costUnknownRows,
      missingTotal,
      eventTokenSignals,
    }),
    eventTokenSignals,
  };
}

function warningsFor(input: {
  rows: number;
  costIncludedRows: number;
  costUnknownRows: number;
  missingTotal: number;
  eventTokenSignals: number;
}): string[] {
  const warnings = [...BASE_WARNINGS];
  if (input.missingTotal > 0) {
    warnings.push('Des lignes n’ont pas de total de jetons. Elles ne sont pas reconstruites.');
  }
  if (input.eventTokenSignals > 0) {
    warnings.push(
      'Des signalements MCP contiennent des jetons déclarés. Ils ne sont pas additionnés ici.',
    );
  }
  if (input.rows === 0) warnings.push('Aucune ligne observée pour ces filtres.');
  return warnings;
}

export function buildInsights(input: {
  rows: number;
  unassigned: number;
  costIncludedRows: number;
  costUnknownRows: number;
  missingTotal: number;
  undated: number;
  peak: { day: string; tokens: number } | null;
  eventTokenSignals: number;
}): Insight[] {
  const insights: Insight[] = [
    {
      id: 'no-savings',
      title: 'Aucune économie estimée',
      detail:
        'Ces règles décrivent uniquement les lignes observées. Elles ne promettent pas d’économie.',
      rule: 'Ne jamais convertir un total de jetons en pourcentage de quota, ni un coût inconnu en zéro.',
    },
  ];
  if (input.rows === 0) {
    insights.push({
      id: 'empty',
      title: 'Aucune ligne observée',
      detail:
        'Le mode réel ne fabrique pas d’usage. Importez un CSV, ou activez explicitement la démonstration.',
      rule: 'Sans lignes, aucun total n’est affiché.',
    });
    return insights;
  }
  if (input.costIncludedRows > 0 || input.costUnknownRows > 0) {
    insights.push({
      id: 'cost-not-zero',
      title: 'Des coûts restent inconnus',
      detail: `${input.costIncludedRows} ligne(s) « Included » et ${input.costUnknownRows} valeur(s) non numérique(s) sont hors somme.`,
      rule: 'Included, « - » et tout texte non numérique → coût inconnu, exclu de l’addition.',
    });
  }
  if (input.unassigned > 0) {
    insights.push({
      id: 'unassigned',
      title: 'Des lignes ne sont pas attribuées',
      detail: `${input.unassigned} ligne(s) n’ont pas de fiche correspondante. Elles restent non attribuées.`,
      rule: 'Sans identifiant reconnu, la ligne n’est pas affectée automatiquement à un bot.',
    });
  }
  if (input.missingTotal > 0) {
    insights.push({
      id: 'partial-tokens',
      title: 'Jetons partiels',
      detail: `${input.missingTotal} ligne(s) n’ont pas de total. Le graphique n’additionne que les totaux présents.`,
      rule: 'Ne pas fabriquer un total manquant pour le comparer à un quota.',
    });
  }
  if (input.undated > 0) {
    insights.push({
      id: 'undated',
      title: 'Lignes sans jour',
      detail: `${input.undated} ligne(s) n’ont pas de date lisible. Elles restent hors du graphique quotidien.`,
      rule: 'Une date illisible n’est pas remplacée par aujourd’hui.',
    });
  }
  if (input.peak && input.peak.tokens > 0) {
    insights.push({
      id: 'peak-day',
      title: 'Jour le plus chargé observé',
      detail: `Le ${input.peak.day}, ${input.peak.tokens.toLocaleString('fr-FR')} jetons totaux sont présents dans les lignes datées.`,
      rule: 'Le pic est le maximum des totaux renseignés, pas une capacité ni un quota.',
    });
  }
  if (input.eventTokenSignals > 0) {
    insights.push({
      id: 'mcp-partial',
      title: 'Signalements partiels',
      detail: `${input.eventTokenSignals} signalement(s) MCP portent des jetons déclarés. Ils ne complètent pas cet import.`,
      rule: 'Un auto-signalement n’est pas un relevé exhaustif du compte.',
    });
  }
  return insights;
}
