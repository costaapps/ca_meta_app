import { ActivatedRoute } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { NEVER } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { AutomationConfigService } from '../../core/portal/automation-config.service';
import { PortalContextStore } from '../../core/portal/portal-context.store';
import { PortalTenantIdentityService } from '../../core/portal/portal-tenant-identity.service';
import { AssetAutomationConfigComponent } from './asset-automation-config.component';

type AutomationConfig = components['schemas']['AutomationConfig'];

describe('AssetAutomationConfigComponent', () => {
  it('shows channel-supported fields and keeps edits disabled until the tenant identity gate is confirmed', async () => {
    const config: AutomationConfig = {
      assetId: '00000000-0000-4000-8000-000000000051',
      assetKind: 'WHATSAPP_PHONE_NUMBER',
      inheritanceMode: 'ASSET_ONLY',
      supportedFields: ['privateWelcomeMessage'],
      privateWelcomeMessage: null,
      commentPublicReply: null,
      commentPrivateReply: null,
      capabilities: { canEdit: true, executable: false },
      version: 0,
      updatedAt: null,
      projectionState: 'UNKNOWN',
      requestId: 'req-synthetic-automation-ui-02',
    };
    const settings = { read: vi.fn(), update: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [AssetAutomationConfigComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: NEVER } },
        { provide: AutomationConfigService, useValue: settings },
        { provide: PortalContextStore, useValue: { contextChanged$: NEVER } },
        { provide: PortalTenantIdentityService, useValue: { current: {
          confirmed: false,
          reason: 'TENANT_IDENTITY_UNCONFIRMED',
          message: 'Identidade da empresa não confirmada',
        } } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AssetAutomationConfigComponent);
    fixture.componentInstance.config = config;
    fixture.componentInstance.isLoading = false;
    fixture.detectChanges();
    const view = fixture.nativeElement as HTMLElement;
    const fields = Array.from(view.querySelectorAll('textarea')).map((field) => field.id);
    expect(fields).toEqual(['privateWelcomeMessage']);
    expect(view.textContent).toContain('Identidade da empresa não confirmada');
    expect((view.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(settings.update).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
