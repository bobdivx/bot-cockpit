import { describe, expect, it } from 'vitest';
import {
  guardCsvCell,
  interpretRows,
  parseCost,
  parseCsv,
  parseToken,
  suggestMapping,
  toCsv,
} from '../src/server/csv.js';

describe('parseCsv', () => {
  it('retire le BOM, accepte le point-virgule et les guillemets', () => {
    const parsed = parseCsv('\uFEFFDate;Modèle;Note\n01/11/2026;"modèle, a";"ligne\ndeux"\n');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.headers).toEqual(['Date', 'Modèle', 'Note']);
    expect(parsed.records).toEqual([['01/11/2026', 'modèle, a', 'ligne\ndeux']]);
  });

  it('signale un guillemet non fermé sans perdre les lignes précédentes', () => {
    const parsed = parseCsv('A,B\n1,2\n"cassé,3');
    expect(parsed.records).toEqual([['1', '2']]);
    expect(parsed.errors.some((error) => error.message.includes('Guillemet'))).toBe(true);
  });

  it('ignore les commentaires et les lignes vides', () => {
    const parsed = parseCsv('# fixture synthétique\n\nA,B\n1,2\n');
    expect(parsed.records).toEqual([['1', '2']]);
  });

  it('refuse un fichier binaire', () => {
    expect(() => parseCsv('a,b\0c')).toThrow(/UTF-8/);
  });
});

describe('nombres et coûts', () => {
  it('lit les jetons groupés et refuse une fraction', () => {
    expect(parseToken('1 234')).toBe(1234);
    expect(parseToken('1,234')).toBe(1234);
    expect(parseToken('12,5')).toBeNull();
    expect(parseToken('-')).toBeNull();
    expect(parseToken('Included')).toBeNull();
  });

  it('ne transforme pas Included ni un tiret en zéro', () => {
    expect(parseCost('Included')).toEqual({ raw: 'Included', value: null, kind: 'included' });
    expect(parseCost('Inclus')).toMatchObject({ kind: 'included', value: null });
    expect(parseCost('-')).toMatchObject({ kind: 'unknown', value: null });
    expect(parseCost('—')).toMatchObject({ kind: 'unknown', value: null });
    expect(parseCost('1,25 €')).toEqual({ raw: '1,25 €', value: 1.25, kind: 'numeric' });
    expect(parseCost('1.234,56 EUR')).toMatchObject({ value: 1234.56, kind: 'numeric' });
    expect(parseCost('0')).toMatchObject({ value: 0, kind: 'numeric' });
    expect(parseCost('environ 12')).toMatchObject({ kind: 'unknown', value: null });
  });
});

describe('mapping et export', () => {
  it('reconnaît des en-têtes français et anglais', () => {
    const fr = suggestMapping([
      'Date',
      "Jetons d'entrée",
      'Jetons cache',
      'Jetons sortie',
      'Total',
      'Coût',
      'Modèle',
      'Type',
      'Cloud Agent ID',
    ]);
    expect(fr.date).toBe('Date');
    expect(fr.inputTokens).toBe("Jetons d'entrée");
    expect(fr.cost).toBe('Coût');
    expect(fr.model).toBe('Modèle');
    expect(fr.automationId).toBe('Cloud Agent ID');
    const en = suggestMapping([
      'timestamp',
      'prompt tokens',
      'completion tokens',
      'total tokens',
      'cost',
      'model',
    ]);
    expect(en.date).toBe('timestamp');
    expect(en.inputTokens).toBe('prompt tokens');
    expect(en.outputTokens).toBe('completion tokens');
    expect(en.totalTokens).toBe('total tokens');
  });

  it('interprète une ligne française et laisse le coût inclus hors somme', () => {
    const headers = ['Date', 'Total', 'Coût', 'Modèle'];
    const mapping = { ...suggestMapping(headers), dateOrder: 'dmy' as const };
    const [row] = interpretRows(
      headers,
      [['02/11/2026 09:15', '2 500', 'Included', 'fixture-a']],
      mapping,
    );
    expect(row?.day).toBe('2026-11-02');
    expect(row?.totalTokens).toBe(2500);
    expect(row?.costKind).toBe('included');
    expect(row?.costValue).toBeNull();
  });

  it('neutralise les formules à l’export', () => {
    expect(guardCsvCell('=1+1')).toBe(`"'=1+1"`);
    expect(guardCsvCell('+cmd')).toBe(`"'+cmd"`);
    expect(guardCsvCell('@somme')).toBe(`"'@somme"`);
    const csv = toCsv(['Modèle'], [['=1+1']]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain(`"'=1+1"`);
  });
});
