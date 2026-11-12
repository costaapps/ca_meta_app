import { DOCUMENT } from '@angular/common';
import { Inject, InjectionToken, Injectable, inject } from '@angular/core';
import { PROVIDER_AUTHORIZATION_ORIGINS } from '../config/public-runtime-config';

export interface PreparedOnboardingPopup {
  readonly source: Window;
  navigate(url: URL): boolean;
  isClosed(): boolean;
  close(): void;
}

export interface OnboardingProviderLaunchAdapter {
  /** Must be called synchronously from a user gesture. */
  prepare(): PreparedOnboardingPopup | undefined;
  isAllowed(url: URL): boolean;
}

export const ONBOARDING_PROVIDER_ACTIVATION_ENABLED = new InjectionToken<boolean>(
  'ONBOARDING_PROVIDER_ACTIVATION_ENABLED',
  { providedIn: 'root', factory: () => false },
);

@Injectable({ providedIn: 'root' })
export class BrowserOnboardingProviderLaunchAdapter implements OnboardingProviderLaunchAdapter {
  constructor(
    @Inject(DOCUMENT) private readonly documentRef: Document,
    @Inject(PROVIDER_AUTHORIZATION_ORIGINS) private readonly origins: readonly string[],
    @Inject(ONBOARDING_PROVIDER_ACTIVATION_ENABLED) private readonly enabled: boolean,
  ) {}

  prepare(): PreparedOnboardingPopup | undefined {
    if (!this.enabled) return undefined;
    const windowRef = this.documentRef.defaultView;
    if (!windowRef) return undefined;
    const popup = windowRef.open('about:blank', '_blank', 'popup,width=520,height=720');
    if (!popup) return undefined;
    return {
      source: popup,
      navigate: (url) => {
        if (!this.isAllowed(url)) return false;
        try {
          popup.location.replace(url.href);
          return true;
        } catch {
          return false;
        }
      },
      isClosed: () => {
        try { return popup.closed; } catch { return true; }
      },
      close: () => {
        try { if (!popup.closed) popup.close(); } catch { /* Close is best-effort. */ }
      },
    };
  }

  isAllowed(url: URL): boolean {
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      this.origins.includes(url.origin) && url.searchParams.getAll('state').length === 1;
  }
}

export const ONBOARDING_PROVIDER_LAUNCH = new InjectionToken<OnboardingProviderLaunchAdapter>(
  'ONBOARDING_PROVIDER_LAUNCH',
  { providedIn: 'root', factory: () => inject(BrowserOnboardingProviderLaunchAdapter) },
);
