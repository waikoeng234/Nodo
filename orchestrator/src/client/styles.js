import { AVATAR_CSS } from './avatar.tsx'
import { ENGINE_LOGO_CSS } from './engine-logos.js'
import { RUNNING_CSS } from './running.js'
import { TOOL_CALL_CSS } from './tool-call.tsx'
import { TOOL_TIMELINE_CSS } from './tool-timeline.tsx'
import { CODE_DIFF_CSS } from './code-diff.tsx'
import { FILE_CHANGES_SUMMARY_CSS } from './file-changes-summary.tsx'

export const CSS = AVATAR_CSS + ENGINE_LOGO_CSS + RUNNING_CSS + TOOL_CALL_CSS + TOOL_TIMELINE_CSS + CODE_DIFF_CSS + FILE_CHANGES_SUMMARY_CSS + `
.nodo-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-page *{box-sizing:border-box}
.nodo-runs-row{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.nodo-runs-row:hover,.nodo-runs-row[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-runs-row strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}
.nodo-runs-meta{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nodo-run{display:flex;flex-direction:column;gap:12px;flex:1;min-width:0;min-height:0;overflow:auto;padding:0 6px;overflow-wrap:anywhere}
.nodo-run-task{display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-run-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nodo-run-attempt{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nodo-run-output{margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.nodo-run-input{display:grid;gap:2px}
.nodo-run-input>.nodo-run-output{max-height:160px;overflow:auto;color:var(--dsw-alias-label-primary)}
.nodo-run-result{display:grid;gap:2px}
.nodo-run-result>.nodo-run-output{color:var(--dsw-alias-label-primary)}
.nodo-run-steps{display:flex;flex-direction:column;margin:0 -8px;padding:0;list-style:none}
.nodo-run-steps>li{position:relative}
.nodo-run-steps>li:not(:last-child)::after{content:'';position:absolute;left:19px;top:calc(50% + 14px);height:calc(100% - 28px);width:1px;background:var(--dsw-alias-border-l2);pointer-events:none}
.nodo-run-step{--nodo-step-tone:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-run-step:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-run-step[data-state=done]{--nodo-step-tone:var(--dsw-alias-state-success-primary)}
.nodo-run-step[data-state=ongoing]{--nodo-step-tone:var(--dsw-alias-state-business-primary)}
.nodo-run-step[data-state=warning]{--nodo-step-tone:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.nodo-run-step[data-state=error]{--nodo-step-tone:var(--dsw-alias-state-error-primary)}
.nodo-run-step-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;border-radius:50%;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--nodo-step-tone);background:color-mix(in srgb,var(--nodo-step-tone) 14%,transparent)}
.nodo-run-step-copy{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.nodo-run-step-copy>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-run-step-copy>strong{font-size:13px;font-weight:500;line-height:20px}
.nodo-run-step-copy>small{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.nodo-run-step-state{flex:none;font-size:12px;color:var(--nodo-step-tone)}
.nodo-run-actions{display:flex;gap:8px;justify-content:flex-end}
.nodo-space{height:100%;display:flex;flex-direction:column;background:var(--nodo-chrome,var(--dsw-specific-sidebar-fill))}
.nodo-space-chrome{box-sizing:border-box;height:max(36px,var(--dsh-frame-top-clearance,0px));flex:none;display:flex;justify-content:flex-end;align-items:flex-start;padding:10px 12px 0;-webkit-app-region:drag}
.nodo-space-chrome button{-webkit-app-region:no-drag}
.nodo-space-content{display:flex;flex:1;min-height:0}
.nodo-space-sidebar{flex:1;overflow:hidden;background:var(--dsw-specific-sidebar-fill)}
.nodo-space-sidebar .nodo-frame{flex-direction:column}
.nodo-space-sidebar .nodo-rail{width:100%;max-height:none;flex:1;border:0}
.nodo-space-sidebar .nodo-rail-dock{padding-top:8px}
.nodo-space-sidebar .nodo-rail-body{padding-top:12px}
/* The macOS host only exposes its frame columns through these data attributes:
   the centre column sits right before [data-rightbar-col]. Theme tokens resolve
   below <html>, so the chrome variables live on the frame. */
html[data-platform=darwin][data-nodo-space] :has(> [data-rightbar-col]){--nodo-chrome:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-specific-sidebar-fill));--nodo-card-radius:var(--dsw-radius-lg);--nodo-card-edge:.5px solid var(--dsw-alias-border-l3);background:var(--nodo-chrome)}
html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col]){position:relative;isolation:isolate;margin:0 8px 8px 0;border-left:0;border-radius:0 0 var(--nodo-card-radius) 0;background:0 0}
html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col])::before{content:'';position:absolute;inset:var(--dsh-frame-top-clearance,0px) 0 0;z-index:-1;box-sizing:border-box;border:var(--nodo-card-edge);border-left:0;border-radius:0 var(--nodo-card-radius) var(--nodo-card-radius) 0;background:var(--dsw-alias-bg-base);pointer-events:none}
html[data-platform=darwin][data-nodo-space] [data-sidebar-collapsed]>:has(+ [data-rightbar-col]){margin-left:8px;border-radius:0 0 var(--nodo-card-radius) var(--nodo-card-radius)}
html[data-platform=darwin][data-nodo-space] [data-sidebar-collapsed]>:has(+ [data-rightbar-col])::before{border-left:var(--nodo-card-edge);border-radius:var(--nodo-card-radius)}
html[data-platform=darwin][data-nodo-space] [data-phase]:has(header[data-window-drag]){background:0 0}
html[data-platform=darwin][data-nodo-space] header[data-window-drag]{border-bottom-color:transparent}
html[data-platform=darwin][data-nodo-space] header[data-window-drag]:has([data-conversation-tabs]>:only-child){min-height:var(--dsh-frame-top-clearance,0px);padding-bottom:0}
html[data-platform=darwin][data-nodo-space] [data-conversation-tabs]:has(>:only-child){display:none}
html[data-platform=darwin][data-nodo-space] .nodo-page:not(.nodo-space-sidebar){background:0 0}
html[data-platform=darwin][data-nodo-space] .nodo-head{border-bottom:0}
html[data-platform=darwin][data-nodo-space] :is(.nodo-space-sidebar,.nodo-space-sidebar .nodo-rail,.nodo-space-sidebar .nodo-rail-dock){border:0;background:0 0}
html[data-platform=darwin][data-nodo-space] .nodo-space-sidebar .nodo-rail-body{margin-bottom:8px;padding-top:16px;border:var(--nodo-card-edge);border-radius:var(--nodo-card-radius) 0 0 var(--nodo-card-radius);background:var(--dsw-specific-sidebar-fill)}
/* Only the page's own text nodes are reset; the host renderer keeps its own
   heading and paragraph rhythm inside .nodo-reply. */
.nodo-page :is(.nodo-headline,.nodo-note,.nodo-error-line,.nodo-rail-empty,.nodo-feed-empty){margin:0}
.nodo-page .nodo-headline{font-size:18px;font-weight:600;line-height:24px}
.nodo-frame{display:flex;flex:1;min-height:0}
/* The rail body copies the host sidebar: 12px inline padding, 28px icon buttons
   and 16px row actions that only appear on hover. */
/* The host sidebar reserves a 52px top strip and pulls its brand row up 12px, so
   the rail keeps the same 40px of chrome above its own head. */
.nodo-rail{display:flex;flex:none;width:312px;min-height:0;background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.nodo-rail-dock{display:flex;flex-direction:column;align-items:center;gap:8px;flex:none;width:56px;box-sizing:border-box;padding:max(12px,calc(var(--dsh-frame-top-clearance,0px) - 2px)) 0 12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-specific-sidebar-fill));border-right:.5px solid var(--dsw-alias-border-l3)}
.nodo-rail-dock .nodo-icon-btn,.nodo-rail-switch button{width:36px;height:36px;border-radius:var(--dsw-radius-md)}
.nodo-rail-spacer{flex:1}
.nodo-rail-switch{display:flex;flex-direction:column;gap:4px}
.nodo-rail-switch button{position:relative;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.nodo-rail-switch button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-rail-switch button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px var(--dsw-alias-border-l2),0 0 0 .5px var(--dsw-alias-border-l2);cursor:default}
.nodo-rail-badge{position:absolute;top:5px;right:5px;display:inline-flex}
.nodo-rail-body{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;--nodo-rail-inset:12px;padding:max(6px,calc(var(--dsh-frame-top-clearance,0px) - 8px)) var(--nodo-rail-inset) 6px}
.nodo-roster{display:grid;grid-template-columns:repeat(auto-fill,minmax(52px,1fr));row-gap:8px;flex:none;margin-top:4px}
.nodo-roster-cell{position:relative;display:flex;min-width:0}
.nodo-roster-cell>.nodo-roster-item{flex:1}
.nodo-roster-edit{position:absolute;top:22px;left:calc(50% + 4px);display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill),0 1px 2px var(--dsw-alias-border-l2);cursor:pointer;opacity:0;pointer-events:none}
.nodo-roster-cell:hover>.nodo-roster-edit,.nodo-roster-edit:focus-visible{opacity:1;pointer-events:auto}
.nodo-roster-edit:hover:not(:disabled),.nodo-roster-edit[aria-pressed=true]{color:var(--dsw-alias-label-primary)}
.nodo-roster-edit:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.nodo-roster-item{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;padding:2px 0;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.nodo-roster-item:hover,.nodo-roster-item[aria-pressed=true]{color:var(--dsw-alias-label-primary)}
.nodo-roster-avatar{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;box-sizing:border-box;width:34px;height:34px;border-radius:50%;background:var(--dsw-specific-sidebar-nav-item-active)}
.nodo-roster-item[aria-pressed=true] .nodo-roster-avatar{box-shadow:0 0 0 1.5px var(--dsw-alias-state-business-primary)}
.nodo-roster-add .nodo-roster-avatar{background:0 0;border:1px dashed var(--dsw-alias-border-l1)}
.nodo-roster-dot{position:absolute;right:-1px;bottom:-1px;display:inline-flex;padding:1px;border-radius:50%;background:var(--dsw-specific-sidebar-fill)}
.nodo-roster-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px}
.nodo-tree-search{display:flex;padding:2px 0 4px}
.nodo-tree-add{display:inline-flex;flex:none;padding-right:6px}
.nodo-tree-flag{display:inline-flex;flex:none;color:var(--dsw-alias-state-business-primary)}
.nodo-tree{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;margin:12px calc(-1 * var(--nodo-rail-inset)) 0;padding:0 var(--nodo-rail-inset) 16px}
.nodo-tree-node,.nodo-tree-children{display:flex;flex-direction:column;gap:2px}
.nodo-tree-state{display:inline-flex;align-items:center;gap:4px;flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.nodo-logo{display:block;max-width:100%;height:auto;color:var(--dsw-alias-label-primary)}
.nodo-panel-logo{display:inline-flex;align-items:center}
button[aria-label="Nodo"]:has(.nodo-panel-logo)>span:not(:has(.nodo-panel-logo)){display:none}
.nodo-rail-foot{flex:none;padding:8px 0}
.nodo-search-input{width:100%;min-width:0}
.nodo-rail-empty{padding:10px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-project,.nodo-row{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-project{height:34px;padding:0 4px}
.nodo-project:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-project .nodo-row-actions{padding-right:6px}
.nodo-project .nodo-chevron[data-open]{transform:rotate(90deg)}
.nodo-picker{display:flex;flex:1;min-width:0}
.nodo-project-select{display:flex;align-items:center;gap:6px;flex:1;min-width:0;height:100%;padding:0 4px;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.nodo-chevron{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-caption);transition:transform .15s var(--ds-ease-in-out)}
.nodo-chevron[data-open]{transform:rotate(180deg)}
.nodo-project-pick{gap:6px;max-width:240px}
.nodo-project-pick>.nodo-row-title{font-size:inherit;line-height:inherit}
.nodo-project-state{display:inline-flex;flex:none}
.nodo-menu-label{display:inline-flex;align-items:center;gap:6px}
.nodo-menu-dot{display:inline-flex}
/* Row actions follow the host's own workspace row: hidden until the row is
   hovered, its menu is open, or a button inside holds the keyboard. */
.nodo-row-actions{display:none;flex:none;align-items:center;gap:10px}
.nodo-project:hover .nodo-row-actions,.nodo-project:focus-within .nodo-row-actions,.nodo-project[data-menu=open] .nodo-row-actions{display:inline-flex}
.nodo-project[data-menu=open]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-row-action{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-row-action:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.nodo-folder{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-deep-diving)}
.nodo-show-more{margin:2px 0 0;padding:6px 12px 6px 32px;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.nodo-show-more:hover{color:var(--dsw-alias-label-primary)}
.nodo-row{height:36px;padding:0 8px}
.nodo-session-empty{padding:10px 12px 10px 32px}
.nodo-session-item{display:flex;align-items:center;gap:2px;width:100%}
.nodo-session-item>.nodo-session{flex:1;min-width:0}
.nodo-session-item:hover .nodo-row-actions,.nodo-session-item:focus-within .nodo-row-actions,.nodo-session-item[data-menu=open] .nodo-row-actions{display:inline-flex}
.nodo-session[data-archived]{color:var(--dsw-alias-label-tertiary)}
.nodo-row-archived{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.nodo-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-row[aria-current=page]{background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px var(--dsw-alias-border-l2),0 0 0 .5px var(--dsw-alias-border-l2)}
.nodo-row-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.nodo-session .nodo-row-title{flex:1}
.nodo-session .nodo-avatar{flex:none}
.nodo-row-meta{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.nodo-project .nodo-row-meta{margin-left:0}
.nodo-row-state,.nodo-row-running{display:inline-flex;align-items:center;gap:4px;flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.nodo-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transition:background-color .1s,color .1s}
.nodo-icon-btn:focus-visible,.nodo-icon-btn[aria-pressed=true],.nodo-icon-btn.nodo-visible{opacity:1}
.nodo-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-page button:disabled{cursor:not-allowed;opacity:.4}
.nodo-page :focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.nodo-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.nodo-conversation{display:flex;flex-direction:column;flex:1;min-height:0}
/* Host conversation header geometry: 20px inline start, a 30px title row inside
   the window-chrome band, then a hairline. */
.nodo-head{box-sizing:border-box;display:flex;flex-direction:column;flex:none;min-height:var(--dsh-frame-top-clearance,0px);padding:10px 28px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.nodo-title-row{display:flex;align-items:center;gap:10px;min-width:0;min-height:30px;padding-inline-start:max(0px,calc(var(--dsh-frame-leading-clearance,0px) - 20px))}
.nodo-crumb{min-width:0;padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.nodo-ok{color:var(--dsw-alias-state-success-primary)}.nodo-bad{color:var(--dsw-alias-state-error-primary)}
.nodo-error-line{margin:10px 0;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.nodo-note{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}
/* Feed: the host's scroll padding and flow rhythm — 6px between rows, 12px
   before and after a reply, 16px after a process row. */
.nodo-feedwrap{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;container-type:inline-size}
.nodo-feed{flex:1;min-height:0;overflow-y:auto;padding:16px calc(var(--dsh-composer-side-clearance,16px) + 16px)}
.nodo-feed[data-following]{overflow-anchor:none}
.nodo-feed-inner{display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto}
.nodo-feed-inner>*{min-width:0}
.nodo-feed-inner>*+*{margin-top:6px}
.nodo-feed-inner>*[data-flow=response]+*{margin-top:12px}
.nodo-feed-inner>*[data-flow=process]+*{margin-top:16px}
.nodo-feed-empty{margin:24px 0;text-align:center}
.nodo-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.nodo-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);padding:10px 16px;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}
.nodo-reply{min-width:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-streaming-text{position:relative;min-width:0}
.nodo-streaming-caret{position:absolute;width:2px;margin-left:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary);pointer-events:none;animation:nodo-streaming-pulse 1s ease-in-out infinite}
.nodo-streaming-caret[hidden]{display:none}
@keyframes nodo-streaming-pulse{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){.nodo-streaming-caret{animation:none}}
.nodo-row-content{flex:1;min-width:0}
.nodo-row-content-layout{min-width:0}
.nodo-tool-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.nodo-row-summary{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-row-summary[data-error]{color:var(--dsw-alias-state-error-primary)}
.nodo-request-answer{white-space:pre-wrap;overflow-wrap:anywhere}
.nodo-plan-list{display:flex;flex-direction:column;gap:2px;margin:4px 0 4px 4px;padding:0}
.nodo-plan-step{display:flex;gap:8px;align-items:baseline;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.nodo-plan-mark{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.nodo-plan-step[data-status="in_progress"] .nodo-plan-mark{color:var(--dsw-alias-label-primary)}
.nodo-plan-step[data-status="completed"] .nodo-plan-text{color:var(--dsw-alias-label-tertiary)}
.nodo-plan-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.nodo-think-summary{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.nodo-think-summary[data-streaming]{mask-image:linear-gradient(90deg,black calc(100% - 48px),transparent)}
.nodo-think-body{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-secondary)}
.nodo-image-preview{display:inline-block;max-width:100%;padding:0;border:0;background:transparent;color:inherit;cursor:zoom-in}
.nodo-image-preview:disabled{cursor:wait}
.nodo-io-card{margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}
.nodo-io-section{display:grid;grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;overflow-y:auto}
.nodo-io-label{align-self:start;position:sticky;top:0;color:var(--dsw-alias-label-caption)}
.nodo-io-text{min-width:0;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.nodo-io-text[data-error]{color:var(--dsw-alias-state-error-primary)}
.nodo-turn-error{display:grid;grid-template-columns:10px minmax(0,1fr);align-items:start;gap:8px;padding:2px 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));overflow-wrap:anywhere}
.nodo-turn-error-dot{margin-top:5px}
.nodo-turn-error-title{margin-right:6px;color:var(--dsw-alias-state-error-primary);font-weight:600}
.nodo-tobottom{position:absolute;z-index:8;bottom:16px;right:max(calc(var(--dsh-composer-side-clearance,16px) + 16px),calc((100% - var(--dsh-chat-content-width,748px))/2));display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;border-radius:100px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:var(--dsw-elevation-panel);cursor:pointer}
.nodo-tobottom:hover{background:var(--dsw-alias-button-floating-hover)}
.nodo-turnrail{position:absolute;z-index:7;top:50%;right:12px;transform:translateY(-50%);width:28px;max-height:min(max(0px,calc(100% - 64px)),420px);contain:layout;cursor:pointer;pointer-events:auto}
.nodo-turnrail-scroller{position:relative;max-height:inherit;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none}
.nodo-turnrail-scroller::-webkit-scrollbar{display:none}
.nodo-turnrail-fade-top{mask-image:linear-gradient(transparent 0,black 24px 100%)}
.nodo-turnrail-fade-bottom{mask-image:linear-gradient(black 0 calc(100% - 24px),transparent 100%)}
.nodo-turnrail-fade-top.nodo-turnrail-fade-bottom{mask-image:linear-gradient(transparent 0,black 24px calc(100% - 24px),transparent 100%)}
.nodo-turnrail-marks{position:relative;padding:6px 0}
.nodo-turnmark{position:relative;display:block;width:100%;height:10px;padding:0;border:0;border-radius:8px;background:0 0;cursor:pointer}
.nodo-turnmark:before{content:'';position:absolute;top:50%;right:0;width:20px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l4);transform-origin:100%;transform:translateY(-50%) scaleX(.6);transition:transform .14s,background-color .14s}
.nodo-turnmark-preview:before{background:var(--dsw-alias-label-tertiary);transform:translateY(-50%) scaleX(.9)}
.nodo-turnmark-busy:before{animation:nodo-turn-busy 1s ease-in-out infinite}
.nodo-turnmark-active:before{background:var(--dsw-alias-label-primary);transform:translateY(-50%) scaleX(1)}
.nodo-turnmark:focus-visible{outline:none}
.nodo-turnmark:focus-visible:before{background:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));transform:translateY(-50%) scaleX(1)}
.nodo-turnpreview{position:absolute;z-index:1;right:calc(100% + 10px);top:clamp(0px,calc(var(--nodo-preview-center,0px) - 50px),calc(100% - 100px));box-sizing:border-box;width:min(300px,calc(100cqw - 120px));max-height:100px;padding:10px 12px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);overflow:hidden;pointer-events:none;transition:top .14s cubic-bezier(.2,.8,.2,1);animation:nodo-turn-preview-enter .12s ease-out}
.nodo-turnpreview-prompt,.nodo-turnpreview-response{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.nodo-turnpreview-prompt{font-size:13px;font-weight:600;line-height:18px;-webkit-line-clamp:1}
.nodo-turnpreview-response{margin-top:4px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px;-webkit-line-clamp:3}
@keyframes nodo-turn-preview-enter{0%{opacity:0;transform:translate(4px)}to{opacity:1;transform:translate(0)}}
@keyframes nodo-turn-busy{0%,to{opacity:1}50%{opacity:.35}}
@container (max-width:900px){.nodo-turnrail{display:none}}
@media (prefers-reduced-motion:reduce){.nodo-turnrail-scroller,.nodo-turnmark:before,.nodo-turnpreview,.nodo-chevron{transition:none;animation:none;scroll-behavior:auto}}
/* A pending request is the host's own composer takeover, values copied from
   ApprovalPanel.module.css and QuestionComposer.module.css. */
.nodo-approval{display:flex;flex-direction:column;align-items:center;padding:8px calc(var(--dsh-composer-side-clearance,16px) + 16px) 12px}
.nodo-approval-card{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,748px);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}
.nodo-approval-strip{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:18px}
.nodo-approval-body{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;max-height:var(--dsh-composer-text-max-height,336px);padding:12px 16px 0;overflow-y:auto;outline:none}
.nodo-approval-headline{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}
.nodo-approval-command{margin:0;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;word-break:break-all}
.nodo-approval-actions{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px}
.nodo-approval-reject:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}
.nodo-approval-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nodo-question-frame{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,16px) + 16px) 10px}
.nodo-question-card{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,748px);max-height:min(60vh,520px);padding:0 0 10px;border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-panel);overflow:hidden}
.nodo-question-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 24px}
.nodo-question-eyebrow{color:var(--dsw-alias-label-tertiary);margin-bottom:5px;font-size:11px;line-height:16px}
.nodo-question-title{margin:0;font-size:16px;font-weight:500;line-height:22px}
.nodo-question-body{display:flex;flex-direction:column;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.nodo-question-options{display:flex;flex-direction:column;gap:1px;margin:8px 0 0;padding:4px 12px}
.nodo-question-option{display:flex;align-items:flex-start;gap:8px;flex-shrink:0;width:100%;min-height:40px;padding:8px 12px 8px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-md);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s,border-color .12s}
.nodo-question-option:hover:not(:disabled),.nodo-question-option[data-selected]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-question-option[data-selected]{border-color:var(--dsw-alias-border-l2)}
.nodo-question-option:disabled{cursor:default}
.nodo-question-number{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;margin-top:2px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.nodo-question-copy{flex:1;min-width:0}
.nodo-question-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px}
.nodo-question-label{font-size:14px;font-weight:500;line-height:24px}
.nodo-question-badge{padding:0 4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-button-info-fill);font-size:11px;font-weight:600;line-height:18px}
.nodo-question-description{color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:24px}
.nodo-question-report{display:flex;flex-direction:column;gap:4px;flex-shrink:0;max-height:180px;margin:12px 12px 0;padding:8px 12px;overflow-y:auto;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay)}
.nodo-question-answer{box-sizing:border-box;min-height:64px;max-height:144px;margin:8px 12px 0;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:24px;resize:none;outline:none;overflow-y:auto}
.nodo-question-answer:focus{border-color:var(--dsw-alias-state-business-primary)}
.nodo-question-answer::placeholder{color:var(--dsw-alias-label-caption)}
.nodo-question-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding:0 10px 0 18px}
.nodo-question-pager{display:flex;align-items:center;gap:6px;flex-shrink:0}
.nodo-question-progress{color:var(--dsw-alias-label-secondary);white-space:nowrap;word-spacing:-2px;padding:0 4px;font-size:14px;font-weight:500;line-height:24px}
.nodo-question-icon{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-question-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-question-icon:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.nodo-question-feedback{flex:1;min-height:16px;margin:0;color:var(--dsw-alias-state-error-primary);text-align:right;font-size:11px;line-height:16px}
.nodo-question-actions{display:flex;flex-shrink:0;align-items:center;gap:12px}
.nodo-composer{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:12px;flex:none;width:calc(100% - 32px);max-width:calc(var(--dsh-chat-content-width,748px) + 32px);margin:0 auto 4px;padding-top:8px;border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-composer-scroll{max-height:var(--dsh-composer-text-max-height,336px);margin-right:4px;overflow-y:auto}
.nodo-pending{display:flex;flex-direction:column;gap:4px;max-height:160px;margin:0 8px;padding-bottom:8px;overflow-y:auto;border-bottom:1px solid var(--dsw-alias-border-l2)}
.nodo-pending-item{display:flex;align-items:center;gap:12px;min-width:0;padding:6px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:20px}
.nodo-pending-text{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nodo-pending-images{color:var(--dsw-alias-label-caption)}
.nodo-pending-actions{display:flex;flex:none;align-items:center;gap:8px}
.nodo-pending-actions button,.nodo-pending-stop{padding:2px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.nodo-pending-actions button:hover:not(:disabled),.nodo-pending-stop:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.nodo-pending-actions button:disabled,.nodo-pending-stop:disabled{opacity:.5;cursor:default}
.nodo-pending-stop{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%}
.nodo-composer textarea{box-sizing:border-box;display:block;width:100%;min-height:36px;padding:4px 8px 0 14px;border:0;outline:none;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;caret-color:var(--dsw-alias-state-business-primary);resize:none}
.nodo-composer textarea::placeholder{color:var(--dsw-alias-label-caption)}
/* The caret marks focus in the text surface; the page's control ring stays off it. */
.nodo-page .nodo-composer textarea:focus-visible{outline:none}
.nodo-composer-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;min-width:0;padding:2px 8px 6px}
.nodo-composer-tools{display:flex;align-items:center;gap:12px;min-width:0}
.nodo-composer-target{display:inline-flex;align-items:center;gap:8px;min-width:0;margin-left:auto;max-width:calc(100% - 46px)}
.nodo-composer-target:last-child{max-width:100%}
.nodo-composer-images{display:flex;flex-wrap:wrap;gap:8px;padding:0 14px}
.nodo-composer-files{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px;max-height:90px;overflow:auto}
.nodo-user-files{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.nodo-composer-file{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:12px}
.nodo-composer-file>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nodo-composer-file button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}
.nodo-composer-image{position:relative;width:64px;height:64px;overflow:hidden;border-radius:var(--dsw-radius-panel);box-shadow:var(--dsw-elevation-soft)}
.nodo-composer-image-open{display:block;width:100%;height:100%;padding:0;border:0;background:none;cursor:zoom-in}
.nodo-composer-image img{display:block;width:100%;height:100%;object-fit:cover}
.nodo-composer-image-remove{position:absolute;top:3px;right:3px;width:20px;height:20px;padding:0;border:0;border-radius:100px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);font:inherit;line-height:20px;cursor:pointer}
.nodo-attachment{display:block;max-width:100%;max-height:320px;margin-top:6px;border-radius:var(--dsw-radius-panel)}
.nodo-send{display:grid;place-items:center;flex:none;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;transform:translateY(-2px);transition:background-color .1s}
.nodo-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.nodo-send:disabled{opacity:.4;cursor:default}
/* The statistics line under the input card is the host chat's own pill row: one
   centered line of muted 12px groups, each with a small glyph, the whole line a
   button that opens the session statistics dialog. The row is drawn even when
   the session has no figures yet, so the input card keeps its place. */
.nodo-stats{display:flex;justify-content:center;flex:none;min-height:22px;width:calc(100% - 32px);max-width:calc(var(--dsh-chat-content-width,748px) + 32px);margin:0 auto 6px}
.nodo-stats-pill{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 16px;max-width:100%;padding:2px 8px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-caption);font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;cursor:pointer}
.nodo-stats-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.nodo-stats-pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.nodo-stats-group{display:inline-flex;align-items:center;gap:5px;min-width:0;white-space:nowrap}
.nodo-stats-group svg{flex:none;opacity:.85}
/* A turn's own usage sits under its reply as the host chat's caption. */
.nodo-msg-time{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.nodo-reply-foot{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}
.nodo-turn-usage{margin-top:2px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
/* The dialog the line opens: the host chat's statistics sections and label/value
   rows, label left in the secondary colour, value right and tabular. */
.nodo-stats-section{display:flex;flex-direction:column;gap:6px}
.nodo-stats-heading{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.nodo-stats-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;font-size:13px;line-height:20px}
.nodo-stats-row-label{color:var(--dsw-alias-label-secondary)}
.nodo-stats-row-value{min-width:0;text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
/* The add menu copies the model trigger's secondary-button metrics; the context
   dialog lists files with the host row hover. */
.nodo-add{position:absolute;z-index:100;top:auto;bottom:calc(100% + 4px);left:0;right:0;min-width:0;max-width:100%;max-height:min(400px,var(--nodo-add-space,100vh))}
.nodo-add-anchor{position:static}
.nodo-file-anchor{position:absolute;inset:0;pointer-events:none}
.nodo-file-anchor .nodo-add{pointer-events:auto}
.nodo-file-slot{display:none}
.nodo-add-row{display:flex;align-items:baseline;gap:4px;min-width:0;width:100%}
.nodo-add-name{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-add-alias{flex:none;max-width:20%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-add-desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-add-trigger{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.nodo-add-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* The model picker copies the host composer's model trigger and its drill menu
   cells (dsh-client-ui-model-selection): a 28px secondary trigger with the
   level dimmed, rows label-left / value-right, the chevron flipping when open. */
.nodo-model{display:inline-flex;flex:none;min-width:0;max-width:min(360px,100%);margin-left:auto}
.nodo-model-list{width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px)}
.nodo-model-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:100%;height:28px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:400;line-height:20px;cursor:pointer}
.nodo-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-model-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.nodo-model-label,.nodo-model-effort{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-model-effort{flex-shrink:1000;color:var(--dsw-alias-label-caption)}
.nodo-model-icon{display:none;flex:none}
.nodo-composer-row[data-model-compact] .nodo-model-icon{display:block}
.nodo-composer-row[data-model-compact] :is(.nodo-model-label,.nodo-model-effort){display:none}
.nodo-model-cell{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.nodo-model-cell-label{flex:none;white-space:nowrap}
.nodo-model-cell-value{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary)}
.nodo-model-cell-chev{display:inline-flex;flex:none;color:var(--dsw-alias-menu-icon)}
.nodo-role-seat{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:160px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-role-seat-trigger{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:28px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer}
.nodo-role-seat-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-role-seat-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-role-seat-trigger:disabled{cursor:default}
.nodo-role-seat-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.nodo-role-seat-fixed{height:28px;padding:0 6px}
.nodo-role-seat-list{min-width:180px;max-width:min(320px,100vw - 32px);max-height:min(360px,100vh - 96px);overflow-y:auto}
/* The permission control is the host's own PermissionSelect: values copied from
   its compiled PermissionSelect.module.css (dsh-client-ui-permission-presets). */
.nodo-perm{display:inline-flex;flex:none}
.nodo-perm-trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}
.nodo-perm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-perm-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.nodo-perm-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.nodo-perm-icon{flex:none;display:inline-flex}
.nodo-perm-icon svg{width:14px;height:14px}
.nodo-perm-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.nodo-perm-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:inline-flex}
.nodo-perm-chevron-open{transform:rotate(180deg)}
@container (width<=460px){.nodo-perm-trigger:has(.nodo-perm-icon) .nodo-perm-label{display:none}}
.nodo-empty{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:80px;padding:0 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.nodo-headline{font-size:26px;font-weight:500;line-height:32px;color:var(--dsw-alias-label-primary)}
/* The compact factory body must let upward menus and shadows overflow.
   Host CSS module class names differ between Web and Desktop builds. */
.nodo-welcome{display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;min-height:0;padding:24px 16px;box-sizing:border-box}
.nodo-welcome [data-conversation-content][data-content-phase=hero]>[data-conversation-scroll]{overflow:visible}
.nodo-welcome-body{display:flex;flex-direction:column;gap:20px;width:min(calc(clamp(680px,(100% + 32px) * .64,920px) + 64px),100%)}
.nodo-welcome-hero{margin:0;display:flex;flex-direction:column;align-items:center}
.nodo-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.nodo-field>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.nodo-field-required{margin-left:2px;color:var(--dsw-alias-state-error-primary)}
/* Every form in the panel is the host's modal, settings included. The card, the
   input metrics and the field rhythm below are the host's own values
   (Modal.module.css, settings-form/fields.module.css). The modal is portaled out
   of .nodo-page, so these rules stay unscoped. */
.nodo-dialog{width:min(440px,100%);max-height:100%}
.nodo-dialog *{box-sizing:border-box}
.nodo-dialog-fields{display:flex;flex-direction:column;max-height:min(60vh,520px);overflow-y:auto}
.nodo-dialog .nodo-field{gap:6px;padding:12px 0}
.nodo-dialog .nodo-field:first-child{padding-top:0}
.nodo-dialog .nodo-field+.nodo-field{border-top:.5px solid var(--dsw-alias-border-l2)}
/* A row keeps the field rhythm: the row draws the separator and its own fields
   drop the per-field padding and hairline. */
.nodo-dialog-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-dialog-row>.nodo-field,.nodo-dialog-row>.nodo-field+.nodo-field{padding:0;border-top:0}
.nodo-dialog-fields>.nodo-dialog-row:first-child{border-top:0;padding-top:0}
.nodo-dialog-row+.nodo-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-dialog .nodo-field>span{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.nodo-dialog-input{width:100%;height:44px;padding:7px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:400;line-height:22px;outline:none}
.nodo-dialog-input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.nodo-dialog-input:disabled{color:var(--dsw-alias-label-dimmed)}
.nodo-dialog-select{padding-right:32px}
.nodo-dialog-textarea{height:auto;min-height:88px;padding:10px 14px;resize:vertical}
.nodo-dialog-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.nodo-dialog-pick{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.nodo-dialog-path{margin:0;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.nodo-dialog-leading{margin-right:auto}
.nodo-dialog-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nodo-dialog-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.nodo-dialog-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.nodo-dialog :is(.nodo-ok,.nodo-bad,.nodo-dialog-status){margin:0}
.nodo-role-dialog{--nodo-role-radius:var(--dsw-radius-md);width:min(920px,100%);padding:20px;gap:20px;border-radius:calc(var(--nodo-role-radius) + 20px)}
.nodo-role-dialog h2{font-size:18px;font-weight:600;line-height:26px}
.nodo-role-dialog button{border-radius:var(--nodo-role-radius)}
.nodo-role-shell,.nodo-role-shell>div:last-child{min-height:0}
.nodo-role-shell>div:first-child{padding:0 0 20px}
.nodo-role-shell>div:last-child{margin-top:20px}
.nodo-role-dialog>:last-child{flex-shrink:0}
.nodo-role-fields{gap:20px;max-height:min(72vh,680px);margin-right:-12px;padding-right:12px;overscroll-behavior:contain}
.nodo-role-dialog .nodo-field,.nodo-role-dialog .nodo-field+.nodo-field{padding:0;border:0;gap:8px}
.nodo-role-dialog .nodo-field>span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nodo-role-dialog .nodo-dialog-input{height:40px;padding:8px 12px;border-radius:var(--nodo-role-radius);font-size:13px;line-height:22px}
.nodo-role-dialog .nodo-dialog-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nodo-role-dialog .nodo-dialog-select{padding-right:28px}
.nodo-role-layout{display:grid;grid-template-columns:260px minmax(0,1fr);gap:28px;align-items:start}
.nodo-role-aside{position:sticky;top:0;display:flex;flex-direction:column;gap:20px;padding:16px;border-radius:calc(var(--nodo-role-radius) + 12px);background:var(--dsw-alias-bg-layer-1)}
.nodo-role-card{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-base)}
.nodo-role-card-art{display:flex;align-items:center;justify-content:center;height:112px}
.nodo-role-card-body{display:flex;flex-direction:column;gap:6px;padding:14px 16px 16px}
.nodo-role-card-body p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.nodo-role-card-title{display:flex;align-items:center;gap:8px;min-width:0}
.nodo-role-card-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.nodo-role-card-tag{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.nodo-role-card .nodo-role-card-meta{padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.nodo-role-card [data-empty]{color:var(--dsw-alias-label-tertiary)}
.nodo-role-dialog .nodo-role-aside>.nodo-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center}
.nodo-role-dialog .nodo-avatar-preview-toggle{gap:5px;white-space:nowrap;cursor:pointer}
.nodo-role-dialog .nodo-avatar-preview-toggle input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.nodo-role-dialog .nodo-avatar-picker{grid-column:1/-1;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.nodo-role-dialog .nodo-avatar-option{gap:4px;min-height:68px;padding:8px 2px;border-radius:var(--nodo-role-radius)}
.nodo-role-main{display:flex;flex-direction:column;gap:20px;min-width:0}
.nodo-role-main>.nodo-field{position:relative}
.nodo-role-dialog .nodo-role-main>.nodo-field:first-child .nodo-dialog-input{height:44px;font-size:14px}
.nodo-identity-options{display:flex;flex-wrap:wrap;gap:8px}
.nodo-identity-option{max-width:100%;height:34px;padding:0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.nodo-identity-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-identity-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-label-primary)}
.nodo-identity-option[data-saved]::before{content:'';display:inline-block;width:6px;height:6px;margin:0 6px 2px 0;border-radius:50%;background:var(--dsw-alias-state-business-primary);vertical-align:middle}
.nodo-identity-option[data-custom]{border-style:dashed}
.nodo-identity-option:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-identity-option:disabled{opacity:.5;cursor:default}
.nodo-identity-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.nodo-identity-summary>button{flex:none}
.nodo-role-dialog .nodo-identity-save-open{position:absolute;top:-6px;right:0}
.nodo-dialog-counted{position:relative}
.nodo-dialog-counted>.nodo-dialog-input{padding-right:64px}
.nodo-dialog-count{position:absolute;right:12px;bottom:9px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;pointer-events:none}
.nodo-role-dialog .nodo-dialog-counted>.nodo-dialog-textarea{height:200px;min-height:132px;padding:10px 12px 30px;resize:vertical}
.nodo-identity-save{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 6px);background:var(--dsw-alias-bg-layer-1)}
.nodo-identity-save>.nodo-dialog-hint{grid-column:1/-1}
.nodo-role-dialog .nodo-identity-save .nodo-dialog-input{height:34px}
.nodo-role-notice{margin:0;padding:8px 12px;border-radius:var(--nodo-role-radius);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.nodo-role-run{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px)}
.nodo-role-dialog .nodo-role-run .nodo-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,240px);align-items:center;column-gap:12px;row-gap:2px;padding:8px 8px 8px 14px}
.nodo-role-dialog .nodo-role-run .nodo-field+.nodo-field{border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-role-dialog .nodo-role-run .nodo-field>span{font-size:13px;color:var(--dsw-alias-label-primary)}
.nodo-role-dialog .nodo-role-run input[role=switch]{justify-self:start;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.nodo-role-confirm{flex:1;margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.nodo-role-dialog .nodo-dialog-error{margin:0}
@media(max-width:640px){.nodo-role-layout{grid-template-columns:minmax(0,1fr);gap:16px}.nodo-role-aside{position:static}.nodo-role-fields{max-height:64vh;gap:16px}.nodo-role-dialog .nodo-dialog-counted>.nodo-dialog-textarea{height:160px}.nodo-role-dialog .nodo-role-run .nodo-field{grid-template-columns:minmax(0,1fr)}}
.nodo-worktree-toggle{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.nodo-worktree-toggle input{accent-color:var(--dsw-alias-state-business-primary)}
.nodo-worktree-modes{display:flex;align-items:center;gap:6px}
.nodo-branch-input{display:flex;align-items:center;gap:4px}
.nodo-branch-input .nodo-dialog-input{flex:1;min-width:0;width:auto}
.nodo-branch-toggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:44px;padding:0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-branch-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-engine-dialog{--nodo-engine-radius:var(--dsw-radius-md);width:min(800px,100%);gap:14px;padding-bottom:16px;border-radius:calc(var(--nodo-engine-radius) + 16px)}
.nodo-engine-dialog button{border-radius:var(--nodo-engine-radius)}
.nodo-engine-dialog h2{font-size:18px;font-weight:600;line-height:26px}
.nodo-engine-shell>div:first-child{padding-top:16px;padding-bottom:8px}
.nodo-engine-shell>p{font-size:12px;line-height:18px}
.nodo-engine-shell,.nodo-engine-shell>div:last-child{min-height:0}
.nodo-engine-shell>div:last-child{margin-top:12px}
.nodo-engine-dialog>:last-child{flex-shrink:0}
.nodo-engine-content{max-height:min(66vh,720px);overflow-y:auto;overscroll-behavior:contain;margin:0 -12px 0 -2px;padding:0 12px 2px 2px}
.nodo-engine-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.nodo-engine-toolbar>.nodo-engine-group{margin:0}
.nodo-engine-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;align-items:stretch}
.nodo-engine-group{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nodo-engine-group>span{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.nodo-engine-card{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.nodo-engine-dialog .nodo-engine-card{border-radius:calc(var(--nodo-engine-radius) + 10px)}
.nodo-engine-card[data-expanded]{grid-column:1/-1;border-color:var(--dsw-alias-border-l4)}
.nodo-engine-card[data-muted] .nodo-engine-mark,.nodo-engine-card[data-muted] .nodo-engine-name strong{opacity:.5}
.nodo-engine-row{display:flex;align-items:center;gap:8px}
.nodo-engine-toggle{display:flex;align-items:center;gap:12px;flex:1;min-width:0;min-height:58px;padding:0 8px 0 9px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-engine-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-engine-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-3px;border-radius:var(--dsw-radius-lg)}
.nodo-engine-toggle:disabled{cursor:default}
.nodo-engine-dialog .nodo-engine-toggle{border-radius:0}
.nodo-engine-mark{display:grid;place-items:center;flex:none;width:34px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}
.nodo-engine-dialog .nodo-engine-mark{width:40px;height:40px;border-radius:var(--nodo-engine-radius)}
.nodo-engine-name{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.nodo-engine-name strong{display:block;font-size:14px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nodo-engine-caption{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nodo-engine-caption[data-bad]{color:var(--dsw-alias-state-error-primary)}
.nodo-engine-toggle .nodo-chevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-engine-switch{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;margin-right:14px;padding:0;border:1.5px solid var(--dsw-alias-border-l3);border-radius:50%;background:transparent;color:var(--dsw-alias-bg-base);cursor:pointer}
.nodo-engine-switch:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.nodo-engine-switch[aria-pressed=true],.nodo-engine-pick[aria-pressed=true] .nodo-engine-switch{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}
.nodo-engine-dialog .nodo-engine-switch{position:relative;width:34px;height:20px;margin:0 19px 0 8px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);transition:background .15s}
.nodo-engine-dialog .nodo-engine-switch[aria-pressed=true]{background:var(--dsw-alias-state-business-primary)}
.nodo-engine-dialog .nodo-engine-switch:disabled{opacity:.5;cursor:default}
.nodo-engine-dialog .nodo-engine-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-soft);transition:transform .15s}
.nodo-engine-dialog .nodo-engine-switch[aria-pressed=true]::after{transform:translateX(14px)}
.nodo-engine-pick{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-engine-pick:hover:not(:disabled),.nodo-engine-pick[aria-pressed=true]{border-color:var(--dsw-alias-border-l4)}
.nodo-engine-pick[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-onboard-dialog{width:min(760px,100%);gap:14px;padding-bottom:16px}
.nodo-engine-detail{margin:0 5px 5px;padding:16px;border-radius:calc(var(--nodo-engine-radius) + 4px);background:var(--dsw-specific-sidebar-fill)}
.nodo-engine-connection{display:flex;justify-content:space-between;align-items:center;gap:12px}
.nodo-engine-connection strong,.nodo-engine-scan strong{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;line-height:20px}
.nodo-engine-connection>button{flex:none}
.nodo-engine-fields{max-height:none;overflow:visible;gap:0}
.nodo-engine-section{margin:14px 0 0;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-engine-fields>.nodo-ok{margin-top:14px}
.nodo-engine-config{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.nodo-engine-dialog .nodo-engine-config>.nodo-field{padding:0;border:0;gap:4px}
.nodo-engine-dialog .nodo-engine-config>.nodo-field>span{font-size:12px}
.nodo-engine-dialog .nodo-dialog-input{height:34px;padding:5px 10px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:20px}
.nodo-engine-section>.nodo-dialog-path{margin-top:6px;font-size:11px}
.nodo-engine-scan{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nodo-engine-scan strong>span{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.nodo-engine-check{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px}
.nodo-engine-check-row{display:grid;grid-template-columns:132px minmax(0,1fr);gap:12px}
.nodo-engine-check dt{display:flex;align-items:baseline;gap:8px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.nodo-engine-check dt>span{flex:none;align-self:center}
.nodo-engine-check dd{margin:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.nodo-engine-check dd.nodo-bad{color:var(--dsw-alias-state-error-primary)}
@media(max-width:640px){.nodo-engine-config{grid-template-columns:minmax(0,1fr)}.nodo-engine-connection{align-items:flex-start;flex-wrap:wrap}.nodo-engine-check-row{grid-template-columns:minmax(0,1fr);gap:2px}.nodo-engine-check dd{padding-left:16px}.nodo-engine-content{max-height:65vh}}
@media(max-width:820px){.nodo-frame{flex-direction:column}.nodo-rail{width:100%;max-height:45%;border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l3)}.nodo-head{padding:10px 16px 0}.nodo-feed{padding:16px}.nodo-composer{width:calc(100% - 24px)}}
`
