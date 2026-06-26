import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MarkdownView, remarkWikilinks } from './MarkdownView';

function renderMd(body: string) {
  return render(
    <MemoryRouter>
      <MarkdownView body={body} />
    </MemoryRouter>,
  );
}

describe('remarkWikilinks', () => {
  it('renders bare [[EP-468]] as a library link with id as label', () => {
    renderMd('See [[EP-468]] for context.');
    const link = screen.getByRole('link', { name: 'EP-468' });
    expect(link).toHaveAttribute('href', '/library/EP-468');
  });

  it('renders [[EP-468|Label]] with custom label and id href', () => {
    renderMd('See [[EP-468|Some Label]] for context.');
    const link = screen.getByRole('link', { name: 'Some Label' });
    expect(link).toHaveAttribute('href', '/library/EP-468');
  });

  it('renders [[nonexistent-id]] as a link even when target does not exist', () => {
    renderMd('Reference: [[nonexistent-id]].');
    const link = screen.getByRole('link', { name: 'nonexistent-id' });
    expect(link).toHaveAttribute('href', '/library/nonexistent-id');
  });

  it('renders multiple wikilinks on the same line', () => {
    renderMd('Compare [[EP-100]] and [[EP-200|Two Hundred]].');
    expect(screen.getByRole('link', { name: 'EP-100' })).toHaveAttribute('href', '/library/EP-100');
    expect(screen.getByRole('link', { name: 'Two Hundred' })).toHaveAttribute('href', '/library/EP-200');
  });

  it('URL-encodes ids with special characters', () => {
    renderMd('Link: [[a/b]].');
    const link = screen.getByRole('link', { name: 'a/b' });
    expect(link).toHaveAttribute('href', '/library/a%2Fb');
  });

  it('exposes the plugin as a function (for remarkPlugins array)', () => {
    expect(typeof remarkWikilinks).toBe('function');
  });
});

describe('MarkdownView (baseline)', () => {
  it('renders plain markdown without wikilinks unchanged', () => {
    renderMd('# Heading\n\nSome **bold** text and a [plain link](https://example.com).');
    const heading = screen.getByRole('heading', { level: 1, name: 'Heading' });
    expect(heading).toBeInTheDocument();
    const ext = screen.getByRole('link', { name: 'plain link' });
    expect(ext).toHaveAttribute('href', 'https://example.com');
  });

  it('renders mixed content: wikilinks + plain markdown coexist', () => {
    renderMd(
      '## Section\n\nRefs: [[EP-1]] and [[EP-2|Two]]. Also **bold** and `code`.',
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Section' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EP-1' })).toHaveAttribute('href', '/library/EP-1');
    expect(screen.getByRole('link', { name: 'Two' })).toHaveAttribute('href', '/library/EP-2');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('renders GFM table when wikilinks are absent', () => {
    renderMd('| a | b |\n|---|---|\n| 1 | 2 |');
    const cell = screen.getByText('1');
    expect(cell.tagName).toBe('TD');
  });

  it('still wraps an external http link with target=_blank', () => {
    renderMd('See [docs](https://example.com).');
    const ext = screen.getByRole('link', { name: 'docs' });
    expect(ext).toHaveAttribute('target', '_blank');
    expect(ext).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders empty body without throwing', () => {
    const { container } = renderMd('');
    expect(container).toBeInTheDocument();
  });
});
