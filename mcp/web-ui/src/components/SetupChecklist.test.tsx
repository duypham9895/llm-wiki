import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { SetupChecklist } from './SetupChecklist';

function renderChecklist() {
  return render(
    <MemoryRouter>
      <SetupChecklist />
    </MemoryRouter>,
  );
}

describe('SetupChecklist', () => {
  it('renders the three onboarding steps as links', () => {
    renderChecklist();

    expect(screen.getByRole('link', { name: /connect notion/i })).toHaveAttribute(
      'href',
      '/admin/sources',
    );
    expect(screen.getByRole('link', { name: /run your first sync/i })).toHaveAttribute(
      'href',
      '/admin/sources',
    );
    expect(screen.getByRole('link', { name: /invite your team/i })).toHaveAttribute(
      'href',
      '/admin/directory',
    );
  });
});
