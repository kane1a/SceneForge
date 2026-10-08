import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { askConfirm } from './confirm';
import { syncSegmentThumbs } from './segmented';
import { analyzeStory, RELATION_LABELS } from './story-analysis';
import { suggestSamePerson, profileNames } from './story-candidates';
import { unitName } from './templates';
import { avatarStyle, AVATAR_HUES } from './avatar';
import { autoTiers, TIER_LABELS, type CharacterTier } from './character-tier';
import { Select } from './ui-controls';
import { PROFILE_FIELDS, type CharacterProfile, type Project, type ProfileField, type SceneMeta } from './types';
import { discardEmptyCharacterDraft, parseCharacterDraftFocusKey, updateCharacterDraft } from './project-mutations.mjs';

interface Props {
  project: Project;
  sceneEighths: Record<string, number>;
  onProfile: (name: string, profile: CharacterProfile) => void;
  onAddDraft: () => void;
  onDraftChange: (change: (project: Project) => Project) => void;
  onCommitDraft: (draftId: string, name: string) => Promise<string | false>;
  onMeta: (blockId: string, meta: SceneMeta) => void;
  onOpen: (blockId: string) => void;
  onExport: () => void;
  onRename: (from: string, to: string) => Promise<string | false>;
  onDeleteProfile?: (name: string) => void;
  activeTab?: 'people' | 'outline';
  focusCharacter?: string;
  onTabChange?: (tab: 'people' | 'outline') => void;
  onFocusCharacter?: (name: string) => void;
  focusUnitId?: string;
  onAliases?: (name: string, aliases: string[]) => void;
  onDismissIdentity?: (key: string) => void;
  onMergeIdentity?: (names: [string, string], key: string) => void;
}

export const PROFILE_LABELS: Record<ProfileField, { label: string; hint: string; long?: boolean }> = {
  age: { label: '年齡', hint: '如：40 歲' },
  role: { label: '身分／職業', hint: '如：老街修傘師傅' },
  look: { label: '外型', hint: '觀眾第一眼看到什麼', long: true },
  personality: { label: '個性', hint: '三個形容詞，加一個矛盾', long: true },
  want: { label: '想要', hint: '外在目標：他以為自己要什麼', long: true },
  need: { label: '需要', hint: '內在需求：他真正缺的是什麼', long: true },
  flaw: { label: '缺陷', hint: '阻礙他的性格弱點', long: true },
  arc: { label: '人物弧線', hint: '從哪裡開始、在哪裡結束', long: true },
  backstory: { label: '背景故事', hint: '劇情開始前發生的事', long: true },
  notes: { label: '備註', hint: '口頭禪、口音、道具…', long: true },
};

/** Series bible: character profiles next to what the script already says about them, and the act / episode outline. */
export default function SeriesBible({ project, sceneEighths, onProfile, onAddDraft, onDraftChange, onCommitDraft, onMeta, onOpen, onExport, onRename, onDeleteProfile, activeTab, focusCharacter, onTabChange, onFocusCharacter, focusUnitId, onAliases, onDismissIdentity, onMergeIdentity }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInFlightRef = useRef(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasWarning, setAliasWarning] = useState('');
  const analysis = useMemo(() => analyzeStory(project), [project]);
  const identitySuggestions = useMemo(() => suggestSamePerson(project).filter((item) => !(project.dismissedIdentitySuggestions ?? []).includes(item.key)), [project]);
  const bible = project.bible ?? {};
  const names = useMemo(() => profileNames(project), [project]);
  const [tab, setTab] = useState<'people' | 'outline'>('people');
  const [selected, setSelected] = useState<string>('');
  const [draftNameWarning, setDraftNameWarning] = useState('');
  const [identityOpen, setIdentityOpen] = useState(false);
  const draftCommitInFlightRef = useRef(false);
  const previousFocusRef = useRef(focusCharacter);
  const latestDraftChangeRef = useRef(onDraftChange);
  const latestFocusRef = useRef(focusCharacter);
  const cleanupTimerRef = useRef<number | null>(null);
  latestDraftChangeRef.current = onDraftChange;
  latestFocusRef.current = focusCharacter;
  const focusedDraftId = parseCharacterDraftFocusKey(focusCharacter ?? '');
  const currentDraft = project.characterDrafts?.find((draft) => draft.id === focusedDraftId);
  const current = currentDraft ? '' : selected && names.includes(selected) ? selected : names[0] ?? '';
  const info = analysis.characters.find((item) => item.name === current);
  const tiers = useMemo(() => autoTiers(analysis.characters), [analysis.characters]);
  const [hueOpen, setHueOpen] = useState(false);
  const hueTrackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hueOpen) return;
    const close = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.avatar-hue-popover, .avatar-color-custom'))) setHueOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setHueOpen(false); };
    window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc); };
  }, [hueOpen]);
  const profile = bible[current] ?? {};
  const fieldsProfile: CharacterProfile = currentDraft?.fields ?? profile;
  const displayName = currentDraft?.fields.name?.trim() ?? current;
  const hasProfile = Object.hasOwn(bible, current);
  const unit = unitName(project.kind);
  useLayoutEffect(() => { syncSegmentThumbs(); }, [tab]);
  useEffect(() => { if (activeTab) setTab(activeTab); }, [activeTab]);
  useEffect(() => {
    if (!focusCharacter) return;
    const draftId = parseCharacterDraftFocusKey(focusCharacter);
    if (draftId && project.characterDrafts?.some((draft) => draft.id === draftId)) { setSelected(''); setTab('people'); return; }
    if (names.includes(focusCharacter)) { setSelected(focusCharacter); setTab('people'); }
  }, [focusCharacter, names, project.characterDrafts]);
  useEffect(() => {
    const previousDraftId = parseCharacterDraftFocusKey(previousFocusRef.current ?? '');
    previousFocusRef.current = focusCharacter;
    if (previousDraftId && previousDraftId !== parseCharacterDraftFocusKey(focusCharacter ?? '')) {
      onDraftChange((current) => discardEmptyCharacterDraft(current, previousDraftId));
    }
  }, [focusCharacter, onDraftChange]);
  useEffect(() => {
    if (cleanupTimerRef.current !== null) window.clearTimeout(cleanupTimerRef.current);
    return () => {
      cleanupTimerRef.current = window.setTimeout(() => {
        const draftId = parseCharacterDraftFocusKey(latestFocusRef.current ?? '');
        if (draftId) latestDraftChangeRef.current((current) => discardEmptyCharacterDraft(current, draftId));
        cleanupTimerRef.current = null;
      }, 0);
    };
  }, []);
  const chooseTab = (next: 'people' | 'outline') => { setTab(next); onTabChange?.(next); };
  const updateDraftField = (field: ProfileField | 'name', value: string) => {
    if (!currentDraft) return;
    onDraftChange((current) => updateCharacterDraft(current, currentDraft.id, { [field]: value }));
  };
  const updateAvatarHue = (hue?: number) => {
    if (!current || currentDraft || profile.avatarHue === hue) return;
    const next: CharacterProfile = { ...profile };
    if (hue === undefined) delete next.avatarHue;
    else next.avatarHue = hue;
    onProfile(current, next);
  };
  const updateTier = (value: string) => {
    if (!current || currentDraft) return;
    const next: CharacterProfile = { ...profile };
    if (value === 'auto') delete next.tier; else next.tier = value as CharacterTier;
    onProfile(current, next);
  };
  const hueFromPointer = (clientX: number) => {
    const rect = hueTrackRef.current?.getBoundingClientRect();
    if (!rect) return;
    updateAvatarHue(Math.max(0, Math.min(359, Math.round((clientX - rect.left) / rect.width * 359))));
  };
  const commitDraftName = () => {
    const draft = currentDraft;
    const name = draft?.fields.name?.trim() ?? '';
    if (!draft || !name || draftCommitInFlightRef.current) return;
    draftCommitInFlightRef.current = true;
    void onCommitDraft(draft.id, name).then((result) => {
      if (!result) { setDraftNameWarning('角色名稱重複，請確認合併流程，或修改名稱。'); return; }
      setDraftNameWarning('');
      setSelected(result);
      if (parseCharacterDraftFocusKey(latestFocusRef.current ?? '') === draft.id) onFocusCharacter?.(result);
    }).catch(() => setDraftNameWarning('角色名稱尚未儲存，請修改名稱後再試。')).finally(() => { draftCommitInFlightRef.current = false; });
  };

  const units = useMemo(() => {
    const list: { id: string; title: string; scenes: { id: string; number: number; heading: string }[] }[] = [];
    let number = 0;
    for (const block of project.blocks) {
      if (block.type === 'act') list.push({ id: block.id, title: block.text.trim() || `未命名${unit}`, scenes: [] });
      if (block.type === 'scene') {
        number += 1;
        if (!list.length) list.push({ id: '', title: '開場', scenes: [] });
        list[list.length - 1].scenes.push({ id: block.id, number, heading: block.text.trim() || '未命名場景' });
      }
    }
    return list;
  }, [project.blocks, unit]);
  useEffect(() => {
    if (activeTab !== 'outline' || !focusUnitId) return;
    document.getElementById(`bible-unit-${focusUnitId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeTab, focusUnitId, units.length]);
  const meta = project.sceneMeta ?? {};
  const aliases = project.entities.find((entity) => entity.name === current)?.aliases ?? [];
  const addAlias = (raw = aliasDraft) => {
    const value = raw.trim();
    if (!value) return;
    const normalized = value.normalize('NFKC').toLocaleLowerCase();
    if (normalized === current.normalize('NFKC').toLocaleLowerCase()) { setAliasWarning(`「${value}」就是這個角色的名稱。`); return; }
    const aliasOwner = project.entities.find((entity) => entity.name !== current && entity.aliases.some((alias) => alias.normalize('NFKC').toLocaleLowerCase() === normalized));
    if (aliasOwner) { setAliasWarning(`「${value}」已是「${aliasOwner.name}」的其他稱呼。`); return; }
    const existing = names.find((name) => name !== current && name.normalize('NFKC').toLocaleLowerCase() === normalized);
    if (existing) {
      // Same person under another existing character name: merge after a warning (handled by App's rename/merge flow).
      setAliasWarning('');
      void Promise.resolve(onRename?.(current, existing)).then((result) => { if (result) setAliasDraft(''); });
      return;
    }
    if (aliases.some((alias) => alias.normalize('NFKC').toLocaleLowerCase() === normalized)) { setAliasDraft(''); setAliasWarning(''); return; }
    onAliases?.(current, [...aliases, value]); setAliasDraft(''); setAliasWarning('');
  };
  const cancelRename = () => { setRenameDraft(renaming ?? ''); setRenaming(null); };
  const commitRename = () => {
    if (renameInFlightRef.current || !renaming) return;
    const from = renaming;
    const to = renameDraft.trim();
    if (!to || to === from) { setRenameDraft(from); setRenaming(null); return; }
    renameInFlightRef.current = true;
    void onRename(from, to).then((result) => {
      if (result) { setSelected(result); onFocusCharacter?.(result); }
      else setRenameDraft(from);
      setRenaming(null);
    }).catch(() => {
      setRenameDraft(from);
      setRenaming(null);
    }).finally(() => { renameInFlightRef.current = false; });
  };
  const deleteProfile = async () => {
    const confirmed = await askConfirm({
      title: `刪除「${current}」的人物設定？`,
      message: `人物設定資料會刪除，但劇本文字不會修改。若「${current}」仍出現在劇本中，之後會再次以偵測到的人物出現。可以用 Ctrl+Z 復原。`,
      confirmLabel: '刪除設定', cancelLabel: '取消', danger: true,
    });
    if (confirmed) onDeleteProfile?.(current);
  };
  const removeAlias = async (alias: string) => {
    const confirmed = await askConfirm({ title: `移除其他稱呼「${alias}」？`, message: '只會移除這個稱呼，不會修改劇本文字。可以用 Ctrl+Z 復原。', confirmLabel: '移除', cancelLabel: '取消', danger: true });
    if (confirmed) onAliases?.(current, aliases.filter((item) => item !== alias));
  };


  return <div className="bible-view">
    <header className="bible-head"><div className="bible-head-title"><div className="story-page-heading"><h2 className="bible-page-title story-page-title">人物設定</h2><p className="story-page-subtitle">整理人物背景、目標與人物弧線。</p></div>{identitySuggestions.length > 0 && <button className="button-ghost button-small" aria-haspopup="dialog" aria-expanded={identityOpen} onClick={() => setIdentityOpen((open) => !open)}>可能是同一人（{identitySuggestions.length}）</button>}</div><div className="bible-head-actions"><button className="button-primary button-small" onClick={onAddDraft}>新增角色</button><button className="button-ghost button-small" onClick={onExport}>匯出設定集（Word）</button></div></header>
    {identityOpen && identitySuggestions.length > 0 && <section className="identity-suggestions" role="dialog" aria-label="可能是同一人">
      <div><strong>可能是同一人</strong><small>只提供建議，不會自動合併。</small></div>
      {identitySuggestions.map((suggestion) => <article key={suggestion.key}><span>{suggestion.names[0]} 和 {suggestion.names[1]} 可能是同一人？<small>{suggestion.reason}</small></span><button className="button-primary button-small" onClick={() => { onMergeIdentity?.(suggestion.names, suggestion.key); setIdentityOpen(false); }}>合併</button><button className="button-ghost button-small" onClick={() => onDismissIdentity?.(suggestion.key)}>不是</button></article>)}
    </section>}

    {tab === 'people' ? <div className="bible-people">
      {currentDraft || current ? <section className={`bible-card${currentDraft ? ' bible-draft-card' : ''}`}>
        <header>
          <div className="bible-avatar-editor">
            <span className="gp-avatar large" style={avatarStyle(displayName, currentDraft ? undefined : profile)}>{Array.from(displayName.normalize('NFKC'))[0] ?? '＋'}</span>
            {!currentDraft && <div className="avatar-color-row" data-seg-ignore role="group" aria-label={`${current}頭像顏色`}>
              <button type="button" className={`avatar-color-auto${profile.avatarHue === undefined ? ' active' : ''}`} aria-pressed={profile.avatarHue === undefined} onClick={() => updateAvatarHue()} title="依角色名稱自動配色">自動</button>
              {AVATAR_HUES.map(({ hue, label }) => <button key={hue} type="button" className={`avatar-color-swatch${profile.avatarHue === hue ? ' active' : ''}`} style={{ backgroundColor: `hsl(${hue} 23% 84%)` }} aria-label={`選擇${label}色頭像`} aria-pressed={profile.avatarHue === hue} title={label} onClick={() => updateAvatarHue(hue)} />)}
              {(() => {
                const custom = profile.avatarHue !== undefined && !AVATAR_HUES.some(({ hue }) => hue === profile.avatarHue);
                return <span className="avatar-custom-wrap">
                  <button type="button" className={`avatar-color-custom${custom ? ' active' : ''}`} aria-pressed={custom} aria-expanded={hueOpen} aria-label="自訂頭像顏色" title="自訂顏色" style={custom ? { backgroundColor: `hsl(${profile.avatarHue} 23% 84%)` } : undefined} onClick={() => setHueOpen((open) => !open)}>{custom ? '' : '＋'}</button>
                  {hueOpen && <div className="avatar-hue-popover" role="dialog" aria-label="自訂頭像顏色">
                    <div className="avatar-hue-preview"><span className="gp-avatar" style={avatarStyle(current, profile)}>{Array.from(current.normalize('NFKC'))[0]}</span><small>拖曳選擇顏色，所有顯示這個角色的地方都會一起換色</small></div>
                    <div ref={hueTrackRef} className="avatar-hue-track" role="slider" tabIndex={0} aria-label="色相" aria-valuemin={0} aria-valuemax={359} aria-valuenow={profile.avatarHue ?? 0}
                      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); hueFromPointer(event.clientX); }}
                      onPointerMove={(event) => { if (event.buttons & 1) hueFromPointer(event.clientX); }}
                      onKeyDown={(event) => { const base = profile.avatarHue ?? 0; if (event.key === 'ArrowRight') { event.preventDefault(); updateAvatarHue((base + 5) % 360); } if (event.key === 'ArrowLeft') { event.preventDefault(); updateAvatarHue((base + 355) % 360); } }}>
                      {profile.avatarHue !== undefined && <i className="avatar-hue-knob" style={{ left: `${profile.avatarHue / 359 * 100}%`, backgroundColor: `hsl(${profile.avatarHue} 23% 84%)` }} />}
                    </div>
                  </div>}
                </span>;
              })()}
            </div>}
          </div>
          <div className={currentDraft ? 'bible-draft-heading' : undefined}>{currentDraft
            ? <input className="bible-draft-name" autoFocus value={currentDraft.fields.name ?? ''} maxLength={40} placeholder="角色名稱" aria-label="角色名稱" onChange={(event) => updateDraftField('name', event.target.value)} onBlur={commitDraftName} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitDraftName(); } }} />
            : renaming === current
              ? <form className="bible-rename" onSubmit={(event) => { event.preventDefault(); commitRename(); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitRename(); }}>
                  <input autoFocus value={renameDraft} maxLength={40} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancelRename(); } }} aria-label="新的角色名稱" />
                  <button className="button-primary" type="submit" onMouseDown={(event) => event.preventDefault()}>改名</button>
                  <button className="button-ghost" type="button" onMouseDown={(event) => event.preventDefault()} onClick={cancelRename}>取消</button>
                </form>
              : <h2>{current}<button className="bible-rename-btn" title="修改角色名稱（劇本中會一起修改）" aria-label="修改角色名稱" onClick={() => { setRenaming(current); setRenameDraft(current); }}>✎</button></h2>}
            <p>{currentDraft ? (displayName ? '角色草稿' : '尚未命名') : info ? `台詞 ${info.lines} 句 · 出場 ${info.scenes.length} 場${Number.isFinite(info.firstScene) ? ` · 第 ${info.firstScene + 1} 場首次出場` : ''}` : '尚未在劇本中出場'}</p>
            {draftNameWarning && currentDraft && <small className="draft-name-warning" role="alert">{draftNameWarning}</small>}
          </div>
          {!currentDraft && <div className="bible-header-actions">
            <Select ariaLabel="角色層級" className="bible-tier-select" value={profile.tier ?? 'auto'} options={[{ value: 'auto', label: `自動（${TIER_LABELS[tiers.get(current) ?? 'support']}）` }, ...(['lead', 'support', 'extra'] as CharacterTier[]).map((tier) => ({ value: tier, label: TIER_LABELS[tier] }))]} onChange={updateTier} menuMinWidth={160} />
            {info && Number.isFinite(info.firstScene) && <button className="toolbar-button" onClick={() => onOpen(analysis.scenes[info.firstScene].id)}>跳到首次出場</button>}
          </div>}
        </header>
        {currentDraft && !displayName && <p className="bible-draft-notice">尚未輸入名稱：這個角色不會出現在人物關係圖、知情表與角色名補全中。</p>}
        {!currentDraft && <div className="alias-manager"><strong>其他稱呼</strong><div className="alias-chips">{aliases.map((alias) => <span className="alias-chip" key={alias}>{alias}<button type="button" aria-label={`移除其他稱呼 ${alias}`} title={`移除其他稱呼 ${alias}`} onClick={() => void removeAlias(alias)}>×</button></span>)}

          <form onSubmit={(event) => { event.preventDefault(); addAlias(); }}><input aria-label="新增其他稱呼" placeholder="輸入後按 Enter" value={aliasDraft} onChange={(event) => { const value = event.target.value; const parts = value.split(/[、,，;]/); let aliasConflict = false; if (parts.length > 1) { const next = [...aliases]; for (const raw of parts.slice(0, -1)) { const alias = raw.trim(); if (!alias) continue; const normalized = alias.normalize('NFKC').toLocaleLowerCase(); if (normalized === current.normalize('NFKC').toLocaleLowerCase() || names.some((name) => name !== current && name.normalize('NFKC').toLocaleLowerCase() === normalized) || project.entities.some((entity) => entity.name !== current && entity.aliases.some((item) => item.normalize('NFKC').toLocaleLowerCase() === normalized))) { aliasConflict = true; setAliasWarning(`「${alias}」與現有角色名稱或其他稱呼重複。`); continue; } if (!next.some((item) => item.normalize('NFKC').toLocaleLowerCase() === normalized)) next.push(alias); } if (next.length > aliases.length) onAliases?.(current, next); setAliasDraft(parts.at(-1) ?? ''); } else { setAliasDraft(value); setAliasWarning(''); } if (parts.length > 1 && !aliasConflict) setAliasWarning(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAlias(); } }} /></form></div>
          <small className="alias-help">暱稱、暫稱、英文名等，都算同一人。</small>
          {aliasWarning && <small className="alias-warning" role="alert">{aliasWarning}</small>}
        </div>}
        <div className="bible-fields">
          {PROFILE_FIELDS.map((field) => {
            const spec = PROFILE_LABELS[field];
            return <label key={field} className={spec.long ? 'long' : ''}>{spec.label}
              {spec.long
                ? <textarea rows={field === 'backstory' || field === 'notes' ? 4 : 2} value={fieldsProfile[field] ?? ''} placeholder={spec.hint} onChange={(event) => currentDraft ? updateDraftField(field, event.target.value) : onProfile(current, { ...profile, [field]: event.target.value })} />
                : <input value={fieldsProfile[field] ?? ''} placeholder={spec.hint} onChange={(event) => currentDraft ? updateDraftField(field, event.target.value) : onProfile(current, { ...profile, [field]: event.target.value })} />}
            </label>;
          })}
        </div>
        {!currentDraft && (project.relations ?? []).some((relation) => relation.from === current || relation.to === current) && <div className="bible-relations"><h4>人物關係</h4>
          {(project.relations ?? []).filter((relation) => relation.from === current || relation.to === current).map((relation) => <span key={relation.id} className={`rel-chip rel-${relation.type}`}>{relation.from === current ? relation.to : relation.from}・{relation.label || RELATION_LABELS[relation.type]}</span>)}
        </div>}
        {hasProfile && <footer className="bible-card-actions"><button className="delete-record" type="button" onClick={() => void deleteProfile()}>刪除人物設定</button></footer>}
      </section> : <p className="tl-tip">寫下角色對白後，角色會自動出現在這裡。</p>}
    </div> : <div className="bible-outline">
      {units.map((item) => {
        const minutes = item.scenes.reduce((sum, scene) => sum + (sceneEighths[scene.id] ?? 0), 0) / 8;
        return <section key={item.id || 'prelude'} id={item.id ? `bible-unit-${item.id}` : undefined} className="outline-unit">
          <header><button className="outline-title" onClick={() => onOpen(item.id || item.scenes[0]?.id)}>{item.title}</button><span>{item.scenes.length} 場{minutes ? ` · 約 ${minutes.toFixed(1)} 分` : ''}</span></header>
          {item.id && <div className="outline-summary-edit">
            <textarea rows={2} value={meta[item.id]?.summary ?? ''} placeholder={`這一${unit}的大綱：發生什麼、結尾停在哪裡`} onChange={(event) => onMeta(item.id, { ...meta[item.id], summary: event.target.value })} />
          </div>}
          <ol>{item.scenes.map((scene) => <li key={scene.id}><button onClick={() => onOpen(scene.id)}><b>第 {scene.number} 場</b>{scene.heading}</button>{meta[scene.id]?.summary && <p>{meta[scene.id]!.summary}</p>}</li>)}</ol>
        </section>;
      })}
    </div>}
  </div>;
}
