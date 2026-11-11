import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { NEVER, Subject, of } from 'rxjs';
import type { components } from '@ca-meta/contracts';
import { AutomationConfigService, type VersionedAutomationConfig } from '../../core/portal/automation-config.service';
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

  it('does not apply a delayed save response after the active tenant context changes', async () => {
    const assetId = '00000000-0000-4000-8000-000000000051';
    const config = (privateWelcomeMessage: string, version: number): VersionedAutomationConfig => ({
      etag: `"automation-v${version}"`,
      config: {
        assetId,
        assetKind: 'WHATSAPP_PHONE_NUMBER',
        inheritanceMode: 'ASSET_ONLY',
        supportedFields: ['privateWelcomeMessage'],
        privateWelcomeMessage,
        commentPublicReply: null,
        commentPrivateReply: null,
        capabilities: { canEdit: true, executable: false },
        version,
        updatedAt: null,
        projectionState: 'UNKNOWN',
        requestId: `req-synthetic-automation-ui-${version}`,
      },
    });
    const oldContextConfig = config('Mensagem do tenant anterior', 2);
    const newContextConfig = config('Mensagem do tenant atual', 3);
    const contextChanged$ = new Subject<void>();
    let contextRef = 'synthetic-tenant-context-reference-111';
    const context = {
      contextChanged$: contextChanged$.asObservable(),
      get contextRef() { return contextRef; },
    };
    let resolveUpdate!: (value: VersionedAutomationConfig) => void;
    const settings = {
      read: vi.fn().mockResolvedValueOnce(config('Mensagem original', 1)).mockResolvedValueOnce(newContextConfig),
      update: vi.fn(() => new Promise<VersionedAutomationConfig>((resolve) => { resolveUpdate = resolve; })),
    };
    await TestBed.configureTestingModule({
      imports: [AssetAutomationConfigComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: assetId })) } },
        { provide: AutomationConfigService, useValue: settings },
        { provide: PortalContextStore, useValue: context },
        { provide: PortalTenantIdentityService, useValue: { current: {
          confirmed: true,
          tenantDisplayName: 'Empresa sintética',
          source: 'server-session',
        } } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AssetAutomationConfigComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const component = fixture.componentInstance;
    expect(component.config?.privateWelcomeMessage).toBe('Mensagem original');
    component.form.privateWelcomeMessage = 'Mensagem enviada pelo tenant anterior';
    const save = component.save();
    expect(component.isSaving).toBe(true);

    contextRef = 'synthetic-tenant-context-reference-222';
    contextChanged$.next();
    await fixture.whenStable();
    expect(component.config?.privateWelcomeMessage).toBe('Mensagem do tenant atual');
    expect(component.form.privateWelcomeMessage).toBe('Mensagem do tenant atual');
    expect(component.isSaving).toBe(false);

    resolveUpdate(oldContextConfig);
    await save;
    expect(component.config?.privateWelcomeMessage).toBe('Mensagem do tenant atual');
    expect(component.form.privateWelcomeMessage).toBe('Mensagem do tenant atual');
    expect(component.savedMessage).toBe('');
    expect(component.errorMessage).toBe('');
    expect(component.isSaving).toBe(false);
    fixture.destroy();
  });

  it('ignores a delayed save rejection while a save for the new tenant is in progress', async () => {
    const assetId = '00000000-0000-4000-8000-000000000052';
    const config = (privateWelcomeMessage: string, version: number): VersionedAutomationConfig => ({
      etag: `"automation-v${version}"`,
      config: {
        assetId,
        assetKind: 'WHATSAPP_PHONE_NUMBER',
        inheritanceMode: 'ASSET_ONLY',
        supportedFields: ['privateWelcomeMessage'],
        privateWelcomeMessage,
        commentPublicReply: null,
        commentPrivateReply: null,
        capabilities: { canEdit: true, executable: false },
        version,
        updatedAt: null,
        projectionState: 'UNKNOWN',
        requestId: `req-synthetic-automation-reject-${version}`,
      },
    });
    const contextChanged$ = new Subject<void>();
    let contextRef = 'synthetic-tenant-context-reference-333';
    const context = {
      contextChanged$: contextChanged$.asObservable(),
      get contextRef() { return contextRef; },
    };
    const pendingUpdates: Array<{
      readonly resolve: (value: VersionedAutomationConfig) => void;
      readonly reject: (reason: unknown) => void;
    }> = [];
    const settings = {
      read: vi.fn().mockResolvedValueOnce(config('Tenant inicial', 1)).mockResolvedValueOnce(config('Tenant atual', 2)),
      update: vi.fn(() => new Promise<VersionedAutomationConfig>((resolve, reject) => pendingUpdates.push({ resolve, reject }))),
    };
    await TestBed.configureTestingModule({
      imports: [AssetAutomationConfigComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: assetId })) } },
        { provide: AutomationConfigService, useValue: settings },
        { provide: PortalContextStore, useValue: context },
        { provide: PortalTenantIdentityService, useValue: { current: {
          confirmed: true,
          tenantDisplayName: 'Empresa sintética',
          source: 'server-session',
        } } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AssetAutomationConfigComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const component = fixture.componentInstance;
    component.form.privateWelcomeMessage = 'Alteração do tenant anterior';
    const oldSave = component.save();
    expect(component.isSaving).toBe(true);

    contextRef = 'synthetic-tenant-context-reference-444';
    contextChanged$.next();
    await fixture.whenStable();
    expect(component.config?.privateWelcomeMessage).toBe('Tenant atual');
    expect(component.isSaving).toBe(false);

    component.form.privateWelcomeMessage = 'Alteração do tenant atual';
    const currentSave = component.save();
    expect(component.isSaving).toBe(true);
    pendingUpdates[0]!.reject(new Error('synthetic late old-tenant failure'));
    await oldSave;
    expect(component.errorMessage).toBe('');
    expect(component.errorRequestId).toBeNull();
    expect(component.savedMessage).toBe('');
    expect(component.isSaving).toBe(true);

    pendingUpdates[1]!.resolve(config('Salvo no tenant atual', 3));
    await currentSave;
    expect(component.config?.privateWelcomeMessage).toBe('Salvo no tenant atual');
    expect(component.form.privateWelcomeMessage).toBe('Salvo no tenant atual');
    expect(component.savedMessage).toContain('Configuração salva');
    expect(component.isSaving).toBe(false);
    fixture.destroy();
  });
});
