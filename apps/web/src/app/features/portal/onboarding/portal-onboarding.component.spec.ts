import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { parseOnboardingFlowCatalog } from '../../../core/onboarding/onboarding-flow-catalog';
import { PortalOnboardingService, type PortalOnboardingSnapshot } from '../../../core/onboarding/portal-onboarding.service';
import { PortalOnboardingComponent } from './portal-onboarding.component';

describe('PortalOnboardingComponent', () => {
  let fixture: ComponentFixture<PortalOnboardingComponent>;

  it('shows the exact tenant identity warning and disables every mutation action', async () => {
    const profiles = parseOnboardingFlowCatalog({
      requestId: 'req-catalog-1234567890',
      manifestVersion: 'm4.04-2026-11-10.1',
      profiles: [
        ['FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS'],
        ['INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'],
        ['INSTAGRAM', 'INSTAGRAM_LOGIN'],
        ['WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP'],
        ['WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING'],
      ].map(([flowVariant, authVariant]) => ({
        flowVariant, authVariant, enabled: true, reasonCode: null,
        capabilities: [{ operation: 'READ_STATUS', enabled: true, reasonCode: null }],
      })),
    }, {
      requestId: 'req-flows-1234567890',
      items: [
        'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN', 'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
      ].map((variant) => ({
        variant,
        flowVariant: variant === 'FACEBOOK_LOGIN' ? 'FACEBOOK' :
          variant.startsWith('INSTAGRAM_') ? 'INSTAGRAM' :
            variant === 'WHATSAPP_CLOUD_API' ? 'WHATSAPP_EXCLUSIVE' : 'WHATSAPP_COEXISTENCE',
        journeys: variant.startsWith('INSTAGRAM_')
          ? ['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'] : [variant],
        appConfigurationRef: '33333333-3333-4333-8333-333333333333',
        environment: 'test',
        enabled: true,
        availability: 'AVAILABLE',
        prerequisites: { metaAppConfigured: true, serverAdapterRegistered: true, tenantFeatureFlag: 'ENABLED' },
        requestedCapabilities: ['READ_STATUS'],
      })),
      truncated: false,
    })!;
    const snapshot: PortalOnboardingSnapshot = Object.freeze({
      catalogState: 'loaded',
      profiles,
      attempts: Object.freeze([]),
      notice: 'Identidade da empresa não confirmada',
      busy: false,
      tenantDisplayName: null,
      tenantMutationAllowed: false,
      providerActivationEnabled: false,
    });
    const service = {
      getSnapshot: () => snapshot,
      state$: of(snapshot),
      initialize: vi.fn().mockResolvedValue(undefined),
      canStart: vi.fn(() => false),
      start: vi.fn().mockResolvedValue(false),
      refreshStatus: vi.fn(),
      recover: vi.fn(),
      detachPopup: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [PortalOnboardingComponent],
      providers: [{ provide: PortalOnboardingService, useValue: service }],
    }).compileComponents();
    fixture = TestBed.createComponent(PortalOnboardingComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Identidade da empresa não confirmada');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Identidade da empresa não confirmada');
    const startButtons = [...root.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Iniciar autorização') || button.textContent?.includes('Conectar este número'));
    expect(startButtons.length).toBe(5);
    expect(startButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(service.start).not.toHaveBeenCalled();
  });
});
