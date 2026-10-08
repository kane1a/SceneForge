import type { MindNode, Project } from './types';

export type ConvertDirection = 'to-simplified' | 'to-traditional';

/**
 * 繁簡轉換 for a whole project, via OpenCC. With `phrases` on, regional vocabulary is converted too
 * (軟體 ↔ 软件); otherwise only character forms change. Every name-keyed map is converted with its
 * keys so characters, relations, the bible and the knowledge matrix stay linked.
 */
export async function convertProject(project: Project, direction: ConvertDirection, phrases: boolean): Promise<Project> {
  const convert = direction === 'to-simplified'
    ? (await import('opencc-js/t2cn')).Converter({ from: phrases ? 'twp' : 'tw', to: 'cn' })
    : (await import('opencc-js/cn2t')).Converter({ from: 'cn', to: phrases ? 'twp' : 'tw' });
  const c = (text: string) => convert(text);
  const opt = (text: string | undefined) => text === undefined ? undefined : c(text);
  const node = (item: MindNode): MindNode => ({ ...item, text: c(item.text), children: item.children.map(node) });
  const mapKeys = <T,>(record: Record<string, T> | undefined, value: (item: T) => T) => record && Object.fromEntries(Object.entries(record).map(([key, item]) => [c(key), value(item)]));
  return {
    ...project,
    title: c(project.title),
    blocks: project.blocks.map((block) => ({ ...block, text: c(block.text) })),
    entities: project.entities.map((entity) => ({ ...entity, name: c(entity.name), aliases: entity.aliases.map(c), description: c(entity.description) })),
    claims: project.claims.map((claim) => ({ ...claim, text: c(claim.text) })),
    threads: project.threads.map((thread) => ({ ...thread, title: c(thread.title) })),
    relations: project.relations?.map((relation) => ({ ...relation, from: c(relation.from), to: c(relation.to), label: opt(relation.label) })),
    mindmap: project.mindmap && node(project.mindmap),
    titlePage: project.titlePage && Object.fromEntries(Object.entries(project.titlePage).map(([key, value]) => [key, typeof value === 'string' ? c(value) : value])),
    sceneMeta: project.sceneMeta && Object.fromEntries(Object.entries(project.sceneMeta).map(([key, meta]) => [key, { ...meta, summary: opt(meta.summary), storyTime: opt(meta.storyTime) }])),
    comments: project.comments?.map((comment) => ({ ...comment, text: c(comment.text) })),
    facts: project.facts?.map((fact) => ({ ...fact, text: c(fact.text), known: Object.fromEntries(Object.entries(fact.known).map(([who, scene]) => [who.startsWith('__') ? who : c(who), scene])) })),
    factColumns: project.factColumns?.map((who) => who.startsWith('__') ? who : c(who)),
    bible: mapKeys(project.bible, (profile) => Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, typeof value === 'string' ? c(value) : value]))),
  };
}
