import type { Block, BlockType, Project } from './types';
import { messageText } from './document';
import { withContinuationCues } from './dialogue-rendering.mjs';

/** Final Draft 8+ XML. Element names follow Final Draft's defaults so FD opens it with its own styles. */
const FDX_TYPES: Record<BlockType, string> = {
  scene: 'Scene Heading', action: 'Action', character: 'Character', dialogue: 'Dialogue', parenthetical: 'Parenthetical',
  transition: 'Transition', shot: 'Shot', act: 'New Act', note: 'General', message: 'Action', titlecard: 'Action',
};
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function projectToFdx(project: Project): string {
  const source = project.blocks
    .filter((block) => block.type !== 'note' && (block.type !== 'act' || (project.settings?.showActHeadings ?? project.kind !== 'film')) && block.text.trim());
  const printable = withContinuationCues(source, project.settings?.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay', project.settings?.autoContinuation !== false);
  const paragraphs = printable.map((block) => {
    const titlecard = block.type === 'titlecard';
    return `    <Paragraph${titlecard ? ' Alignment="Center"' : ''} Type="${FDX_TYPES[block.type]}">\n      <Text${titlecard ? ' Style="Bold"' : ''}>${xml(block.type === 'message' ? messageText(block.text) : block.text)}</Text>\n    </Paragraph>`;
  }).join('\n');
  const cover = project.titlePage ?? {};
  const centered = (text: string) => `      <Paragraph Alignment="Center" Type="Action"><Text>${xml(text)}</Text></Paragraph>`;
  const titleLines = [cover.title || project.title, cover.subtitle, cover.author && '編劇', cover.author, cover.basedOn].filter((item): item is string => !!item);
  const bottom = [cover.contact, cover.draft, cover.date].filter((item): item is string => !!item);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
${paragraphs}
  </Content>
  <TitlePage>
    <Content>
${[...Array(12)].map(() => '      <Paragraph Type="Action"><Text></Text></Paragraph>').join('\n')}
${titleLines.map(centered).join('\n')}
${bottom.map((text) => `      <Paragraph Type="Action"><Text>${xml(text)}</Text></Paragraph>`).join('\n')}
    </Content>
  </TitlePage>
</FinalDraft>
`;
}

interface DocxFonts { latin: string; cjk: string }
interface DocxFormat { paper: 'letter' | 'a4'; fontPt: number; lineSpacing: number; paragraphSpacing: number }

/** Word document with one paragraph style per screenplay element (fonts are referenced by name, not embedded). */
export interface DocxOptions { template?: 'hollywood' | 'zh-inline'; sceneNumbers?: boolean; includeCover?: boolean; anonymous?: boolean }

export async function projectToDocx(project: Project, format: DocxFormat, fonts: DocxFonts, options: DocxOptions = {}): Promise<Blob> {
  const docx = await import('docx');
  const { AlignmentType, Document, Header, Packer, PageNumber, Paragraph, TextRun } = docx;
  const inch = 1440;
  const size = Math.round(format.fontPt * 2);
  const hasCjkScript = project.blocks.some((block) => block.type !== 'note' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(block.text));
  const requestedLineSpacing = Math.max(1, format.lineSpacing);
  const lineSpacing = options.template !== 'zh-inline' && hasCjkScript ? Math.max(1.25, requestedLineSpacing) : requestedLineSpacing;
  const line = Math.round(240 * lineSpacing);
  const gapLines = (lines: number) => Math.round(lines * format.fontPt * 20 * lineSpacing * format.paragraphSpacing);
  const font = { ascii: fonts.latin, hAnsi: fonts.latin, eastAsia: fonts.cjk, cs: fonts.latin };
  const geometry: Record<Exclude<BlockType, 'note'>, { left: number; right: number; before: number; bold?: boolean; caps?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; underline?: boolean }> = {
    scene: { left: 0, right: 0, before: 1, bold: true, caps: true },
    action: { left: 0, right: 0, before: 1 },
    character: { left: 2.2, right: 0.5, before: 1, caps: true },
    parenthetical: { left: 1.6, right: 2, before: 0 },
    dialogue: { left: 1, right: 1.5, before: 0 },
    transition: { left: 0, right: 0, before: 1, caps: true, align: AlignmentType.RIGHT },
    shot: { left: 0, right: 0, before: 1, bold: true, caps: true },
    act: { left: 0, right: 0, before: 2, bold: true, caps: true, align: AlignmentType.CENTER, underline: true },
    titlecard: { left: 0, right: 0, before: 1, bold: true, align: AlignmentType.CENTER },
    message: { left: 1, right: 1.5, before: 1 },
  };
  const paragraph = (block: Block, first: boolean, beforeOverride?: number) => {
    const spec = geometry[block.type as Exclude<BlockType, 'note'>];
    const runs = block.text.split('\n').map((text, index) => new TextRun({ text, font, size, bold: spec.bold, allCaps: spec.caps, underline: spec.underline ? {} : undefined, break: index > 0 ? 1 : undefined }));
    return new Paragraph({
      children: runs,
      alignment: spec.align,
      indent: { left: Math.round(spec.left * inch), right: Math.round(spec.right * inch) },
      spacing: { before: first ? 0 : gapLines(beforeOverride ?? spec.before), after: 0, line },
      keepNext: block.type === 'scene' || block.type === 'character' || block.type === 'parenthetical',
    });
  };
  const source = project.blocks.filter((block) => block.type !== 'note' && (block.type !== 'act' || (project.settings?.showActHeadings ?? project.kind !== 'film')) && block.text.trim());
  const printable = withContinuationCues(source, options.template === 'zh-inline' ? 'taiwan-work' : 'us-screenplay', project.settings?.autoContinuation !== false);
  const body: InstanceType<typeof Paragraph>[] = [];
  let sceneNumber = 0;
  // 台式 spacing: same-kind lines sit together, action ↔ dialogue get one blank line, scenes two.
  const zh = options.template === 'zh-inline';
  const kind = (type: BlockType) => type === 'scene' ? 'scene' : ['character', 'dialogue', 'parenthetical'].includes(type) ? 'talk' : type;
  let previousKind = '';
  const zhBefore = (type: BlockType) => { const now = kind(type); const lines = type === 'scene' ? 2 : previousKind === 'scene' || previousKind === now ? 0 : 1; previousKind = now; return lines; };
  for (let index = 0; index < printable.length; index += 1) {
    const block = printable[index];
    if (block.type === 'scene') sceneNumber += 1;
    if (options.template === 'zh-inline' && block.type === 'character') {
      // 角色：對白 on one paragraph with a hanging indent, the common Chinese TV/film layout.
      const name = block.text.trim().replace(/[：:]$/, '');
      const parts: string[] = [];
      let j = index + 1;
      while (j < printable.length && ['parenthetical', 'dialogue'].includes(printable[j].type)) { parts.push(printable[j].text.trim()); j += 1; }
      const hang = Math.round((Array.from(name).length + 1) * format.fontPt * 20);
      body.push(new Paragraph({ children: [new TextRun({ text: `${name}：`, font, size }), new TextRun({ text: parts.join(''), font, size })], indent: { left: hang, hanging: hang }, spacing: { before: body.length ? gapLines(zhBefore('dialogue')) : 0, after: 0, line } }));
      index = j - 1;
      continue;
    }
    let text = block.text;
    if (block.type === 'message') text = messageText(text);
    if (options.sceneNumbers && block.type === 'scene') text = `${sceneNumber}. ${text}`;
    body.push(paragraph({ ...block, text }, body.length === 0, zh ? zhBefore(block.type) : undefined));
  }

  const rawCover = project.titlePage ?? {};
  const cover = options.anonymous ? { ...rawCover, author: '', contact: '' } : rawCover;
  const includeCover = project.titlePage?.print !== false && options.includeCover !== false;
  const centered = (text: string, extra: { bold?: boolean; size?: number; before?: number } = {}) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: extra.before ?? 0 }, children: [new TextRun({ text, font, size: extra.size ?? size, bold: extra.bold })] });
  const coverChildren = !includeCover ? [] : [
    centered(cover.title || project.title, { bold: true, size: Math.round(size * 1.6), before: 3 * inch }),
    ...(cover.subtitle ? [centered(cover.subtitle, { before: 240 })] : []),
    ...(cover.author ? [centered('編劇', { before: 720 }), centered(cover.author, { before: 120 })] : []),
    ...(cover.basedOn ? [centered(cover.basedOn, { before: 480 })] : []),
    ...[cover.contact, cover.draft, cover.date].filter((item): item is string => !!item).map((text, index) => new Paragraph({ spacing: { before: index === 0 ? 2 * inch : 0 }, children: [new TextRun({ text, font, size: Math.round(size * 0.9) })] })),
  ];

  const page = format.paper === 'a4'
    ? { width: 11906, height: 16838, margin: { top: 1417, bottom: 1417, left: 1984, right: 1417 } }
    : { width: 12240, height: 15840, margin: { top: inch, bottom: inch, left: 1.5 * inch, right: inch } };
  const pageProperties = { size: { width: page.width, height: page.height }, margin: { ...page.margin, header: 720 } };
  const screenplaySection = {
    properties: { page: { ...pageProperties, pageNumbers: { start: 1 } }, titlePage: true },
    headers: {
      default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT, '.'], font, size })] })] }),
      first: new Header({ children: [] }),
    },
    children: body,
  };
  const sections = includeCover
    ? [{ properties: { page: pageProperties }, children: coverChildren }, screenplaySection]
    : [screenplaySection];
  const document = new Document({
    creator: options.anonymous ? '' : 'SceneForge',
    title: project.title,
    sections,
  });
  return Packer.toBlob(document);
}

/** Series bible as a Word document: logline-free, just what the writer filled in plus the outline. */
export async function bibleToDocx(project: Project, sections: { name: string; stats: string; fields: { label: string; value: string }[] }[], outline: { title: string; summary: string; scenes: string[] }[], unit: string): Promise<Blob> {
  const docx = await import('docx');
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = docx;
  const font = { ascii: 'Noto Sans TC', hAnsi: 'Noto Sans TC', eastAsia: 'Noto Sans TC', cs: 'Noto Sans TC' };
  const para = (text: string, options: { bold?: boolean; size?: number; before?: number; color?: string } = {}) => new Paragraph({ spacing: { before: options.before ?? 60, after: 60 }, children: [new TextRun({ text, font, bold: options.bold, size: options.size ?? 22, color: options.color })] });
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: `${project.titlePage?.title || project.title}　設定集`, font, size: 40, bold: true })] }),
    para('人物', { bold: true, size: 30, before: 360 }),
  ];
  for (const section of sections) {
    children.push(para(section.name, { bold: true, size: 26, before: 320 }));
    if (section.stats) children.push(para(section.stats, { size: 18, color: '877F72' }));
    for (const field of section.fields) {
      children.push(new Paragraph({ spacing: { before: 80, after: 40 }, children: [new TextRun({ text: `${field.label}：`, font, bold: true, size: 22 }), new TextRun({ text: field.value, font, size: 22 })] }));
    }
  }
  if (outline.length) {
    children.push(para(`分${unit}大綱`, { bold: true, size: 30, before: 480 }));
    for (const item of outline) {
      children.push(para(item.title, { bold: true, size: 26, before: 280 }));
      if (item.summary) children.push(para(item.summary));
      item.scenes.forEach((scene) => children.push(para(`・${scene}`, { size: 20 })));
    }
  }
  return Packer.toBlob(new Document({ creator: 'SceneForge', title: `${project.title} 設定集`, sections: [{ children }] }));
}
