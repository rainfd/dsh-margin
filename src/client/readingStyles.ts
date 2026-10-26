/** Scoped, component-owned styles matching the DSH management-page layout. */
export const readingStyles = `
.margin-reading {
  box-sizing: border-box; height: 100%; min-height: 0; overflow: hidden;
  padding: 0;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  font-size: 14px; line-height: 22px;
}
.margin-reading *, .margin-reading *::before, .margin-reading *::after { box-sizing: border-box; }
.margin-reading__viewport { height: 100%; overflow: auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
.margin-reading__viewport[hidden] { display: none; }
.margin-reading__actions { display: flex; flex: none; flex-wrap: wrap; gap: 8px; align-items: center; }
.margin-reading__content { width: 100%; max-width: 960px; margin: 0 auto; }
.margin-reading__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; padding-top: 28px; margin-bottom: 32px; }
.margin-reading__title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.margin-reading__intro { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.margin-reading__button, .margin-reading__chip, .margin-reading__link {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; text-decoration: none; color: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: transparent; min-height: 32px; padding: 4px 12px;
}
.margin-reading__button:hover:not(:disabled), .margin-reading__chip:hover, .margin-reading__link:hover { background: var(--dsw-alias-bg-layer-2); }
.margin-reading__button:disabled { opacity: .4; cursor: not-allowed; }
.margin-reading__button:focus-visible, .margin-reading__chip:focus-visible, .margin-reading__link:focus-visible, .margin-reading__search:focus-within {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}
.margin-reading__toolbar { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
.margin-reading__search { display: flex; align-items: center; gap: 8px; width: 100%; max-width: 400px; height: 36px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.margin-reading__input { width: 100%; min-width: 0; border: 0; outline: none; padding: 0; font: inherit; background: transparent; color: var(--dsw-alias-label-primary); }
.margin-reading__input::placeholder { color: var(--dsw-alias-label-secondary); }
.margin-reading__filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.margin-reading__select { font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; min-height: 32px; padding: 4px 8px; }
.margin-reading__select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.margin-reading__chip { min-height: 28px; padding: 3px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.margin-reading__chip[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); font-weight: 500; }
.margin-reading__count { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.margin-reading__list { display: flex; flex-direction: column; gap: 12px; list-style: none; margin: 0; padding: 0; }
.margin-reading__item { display: flex; align-items: flex-start; gap: 24px; padding: 20px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.margin-reading__item:hover, .margin-reading__item:focus-within { border-color: color-mix(in srgb, var(--dsw-alias-border-l2) 70%, var(--dsw-alias-label-secondary)); }
.margin-reading__body { flex: 1; min-width: 0; }
.margin-reading__itemTitle { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; overflow-wrap: anywhere; }
.margin-reading__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.margin-reading__source { padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; }
.margin-reading__excerpt { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; margin: 8px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.margin-reading__link { flex: none; min-height: 28px; padding: 3px 8px; border-color: transparent; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.margin-reading__notice { padding: 48px 16px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.margin-reading__notice p { margin: 0 0 16px; }
.margin-reading__notice[data-error='true'] { color: var(--dsw-alias-state-error-primary); }
.margin-reader { max-width: 800px; padding-top: 28px; }
.margin-reader__nav { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin-bottom: 32px; }
.margin-reader__header { margin-bottom: 28px; }
.margin-reader__title { margin: 0; font-size: clamp(24px, 4vw, 32px); line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
.margin-reader__title:focus { outline: none; }
.margin-reader__summary { padding: 16px 20px; margin-bottom: 28px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.margin-reader__summary h2 { margin: 0 0 8px; font-size: 13px; line-height: 20px; font-weight: 600; }
.margin-reader__summary p { margin: 0; }
.margin-reader__warning { padding: 12px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-state-warn-primary); }
.margin-reader__plain { white-space: pre-wrap; overflow-wrap: anywhere; }
.margin-reader__body { font-size: 16px; line-height: 1.85; overflow-wrap: anywhere; }
.margin-reader__body :is(h1, h2, h3, h4) { line-height: 1.4; margin: 1.5em 0 .6em; }
.margin-reader__body :is(p, ul, ol, blockquote, pre, table) { margin-block: 1em; }
.margin-reader__body :is(ul, ol) { padding-inline-start: 1.6em; }
.margin-reader__body blockquote { border-inline-start: 3px solid var(--dsw-alias-border-l2); padding-inline-start: 16px; color: var(--dsw-alias-label-secondary); }
.margin-reader__body :is(pre, table) { max-width: 100%; overflow-x: auto; }
.margin-reader__body pre { padding: 16px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.margin-reader__body :is(img, video) { max-width: 100%; height: auto; }
.margin-reader__body table { display: block; border-collapse: collapse; }
.margin-reader__body :is(th, td) { border: 1px solid var(--dsw-alias-border-l2); padding: 8px 12px; }
.margin-reader__body a { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
.margin-reader__body a:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.margin-reader__progress { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 0; margin-bottom: 8px; background: var(--dsw-alias-bg-base); }
.margin-reader__progressTrack { flex: 1 1 160px; min-width: 96px; height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.margin-reader__progressFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .15s linear; }
.margin-reader__progressLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.margin-reader__progressNote { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.margin-reader__progressNote[role='alert'] { color: var(--dsw-alias-state-warn-primary); }
.margin-reader__toc { display: flex; flex-direction: column; gap: 8px; margin-bottom: 28px; padding: 12px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.margin-reader__tocList { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; max-height: 260px; overflow: auto; }
.margin-reader__tocItem { margin: 0; }
.margin-reader__tocLink { display: block; width: 100%; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; text-align: start; padding: 2px 4px; cursor: pointer; }
.margin-reader__tocLink:hover { background: var(--dsw-alias-bg-layer-2); }
.margin-reader__tocLink:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.margin-reader__tocItem--h2 .margin-reader__tocLink { padding-inline-start: 16px; }
.margin-reader__tocItem--h3 .margin-reader__tocLink { padding-inline-start: 28px; }
.margin-reader__tocItem--h4 .margin-reader__tocLink { padding-inline-start: 40px; }
.margin-reader__tocItem--h5 .margin-reader__tocLink { padding-inline-start: 52px; }
.margin-reader__tocItem--h6 .margin-reader__tocLink { padding-inline-start: 64px; }
.margin-reader__ai { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 12px; }
.margin-reader__aiHead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.margin-reader__aiTitle { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.margin-reader__aiInput { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); min-height: 32px; padding: 4px 8px; }
.margin-reader__aiResult { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding: 16px 20px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.margin-reader__aiResultTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
.margin-reader__aiResultTitle:focus { outline: none; }
.margin-reader__aiBody { font-size: 15px; line-height: 1.8; }
.margin-reader__annotations { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 12px; }
.margin-reader__annotationsHead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.margin-reader__annotationsTitle { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.margin-reader__annotationsHeading { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.margin-reader__annotationsSection { display: flex; flex-direction: column; gap: 10px; padding: 16px 20px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.margin-reader__annotationsForm { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.margin-reader__annotationsInput { display: block; width: 100%; min-height: 88px; resize: vertical; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; padding: 8px 10px; }
.margin-reader__annotationsInput:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.margin-reader__annotationsText { margin: 0; font-size: 14px; line-height: 22px; }
.margin-reader__annotationsPreview { margin: 0; max-height: 160px; overflow: auto; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.margin-reader__annotationsSwatch { display: inline-block; width: 10px; height: 10px; margin-inline-end: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 3px; vertical-align: baseline; }
@media (max-width: 640px) {
  .margin-reading__viewport { padding-inline: 20px; }
  .margin-reading__head { margin-bottom: 24px; }
  .margin-reading__search { max-width: none; }
  .margin-reading__item { flex-direction: column; gap: 8px; padding: 16px; }
}
`
