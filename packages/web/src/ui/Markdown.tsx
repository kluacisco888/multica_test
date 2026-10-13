import MarkdownIt from 'markdown-it';
import { useMemo } from 'react';

/*
 * Task descriptions are Markdown (spec 用户故事 21). Raw HTML in the source is
 * escaped (`html: false`), and markdown-it's link validation drops
 * javascript:/vbscript:/file: URLs and data: URLs other than images, so the
 * only markup in the output is markdown-it's own: safe for innerHTML.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Links open in a new tab without giving it access to this window.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token?.attrSet('target', '_blank');
  token?.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={`markdown ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
