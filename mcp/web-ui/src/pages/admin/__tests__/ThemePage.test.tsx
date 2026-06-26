import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../test/util';
import { TOKEN_STORAGE, DESIGN_DEFAULTS } from '../../../lib/theme';
import { ThemePage } from '../ThemePage';

describe('ThemePage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-density');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--radius');
    document.documentElement.style.removeProperty('--ring');
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders all three controls with defaults', () => {
    renderWithProviders(<ThemePage />, {
      me: { permissions: ['roles.manage'] },
      route: '/admin/theme',
    });

    // Accent: color input + hue slider
    const colorInput = screen.getByLabelText(/accent color picker/i) as HTMLInputElement;
    expect(colorInput).toBeInTheDocument();

    const hueSlider = screen.getByLabelText(/accent hue/i) as HTMLInputElement;
    expect(hueSlider).toBeInTheDocument();
    expect(hueSlider.value).toBe(String(DESIGN_DEFAULTS.accentHue));

    // Density: radiogroup with both buttons
    const densityGroup = screen.getByRole('radiogroup', { name: /density/i });
    expect(densityGroup).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /compact/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /comfortable/i })).toBeInTheDocument();

    // Radius slider
    const radiusSlider = screen.getByLabelText(/border radius/i) as HTMLInputElement;
    expect(radiusSlider).toBeInTheDocument();
    expect(radiusSlider.value).toBe(String(DESIGN_DEFAULTS.radiusPx));

    // Reset button present
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
  });

  it('writes the accent hue to localStorage when the slider changes', () => {
    renderWithProviders(<ThemePage />, {
      me: { permissions: ['roles.manage'] },
      route: '/admin/theme',
    });

    const hueSlider = screen.getByLabelText(/accent hue/i) as HTMLInputElement;
    fireEvent.change(hueSlider, { target: { value: '120' } });

    expect(window.localStorage.getItem(TOKEN_STORAGE.accent)).toBe('120');
    expect(document.documentElement.style.getPropertyValue('--accent')).toContain('120');
  });

  it('writes density to localStorage and flips data-density on the root', () => {
    renderWithProviders(<ThemePage />, {
      me: { permissions: ['roles.manage'] },
      route: '/admin/theme',
    });

    expect(document.documentElement.getAttribute('data-density')).toBe(DESIGN_DEFAULTS.density);

    fireEvent.click(screen.getByRole('radio', { name: /compact/i }));

    expect(window.localStorage.getItem(TOKEN_STORAGE.density)).toBe('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('writes radius to localStorage when the slider changes', () => {
    renderWithProviders(<ThemePage />, {
      me: { permissions: ['roles.manage'] },
      route: '/admin/theme',
    });

    const radiusSlider = screen.getByLabelText(/border radius/i) as HTMLInputElement;
    fireEvent.change(radiusSlider, { target: { value: '4' } });

    expect(window.localStorage.getItem(TOKEN_STORAGE.radius)).toBe('4');
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('4px');
  });

  it('restores defaults and clears localStorage when the reset button is clicked', () => {
    // Seed localStorage with non-default values.
    window.localStorage.setItem(TOKEN_STORAGE.accent, '42');
    window.localStorage.setItem(TOKEN_STORAGE.density, 'compact');
    window.localStorage.setItem(TOKEN_STORAGE.radius, '2');

    renderWithProviders(<ThemePage />, {
      me: { permissions: ['roles.manage'] },
      route: '/admin/theme',
    });

    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('2px');

    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

    expect(window.localStorage.getItem(TOKEN_STORAGE.accent)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE.density)).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE.radius)).toBeNull();

    expect(document.documentElement.getAttribute('data-density')).toBe(DESIGN_DEFAULTS.density);
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe(
      `${DESIGN_DEFAULTS.radiusPx}px`,
    );

    const hueSlider = screen.getByLabelText(/accent hue/i) as HTMLInputElement;
    expect(hueSlider.value).toBe(String(DESIGN_DEFAULTS.accentHue));
  });
});
