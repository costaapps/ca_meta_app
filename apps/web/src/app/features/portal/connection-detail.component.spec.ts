import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { EMPTY } from 'rxjs';
import { MetaFlowCatalogService, MetaFlowProfile } from '../../core/portal/meta-flow-catalog.service';
import { ConnectionDetailComponent } from './connection-detail.component';

describe('ConnectionDetailComponent', () => {
  it('keeps the onboarding call to action disabled until the handler is delivered', () => {
    const component = new ConnectionDetailComponent({} as ActivatedRoute, {} as MetaFlowCatalogService);
    const enabledInstagramProfile: MetaFlowProfile = {
      flowVariant: 'INSTAGRAM',
      authVariant: 'INSTAGRAM_LOGIN',
      enabled: true,
      reasonCode: null,
      capabilities: [{ operation: 'ASSET_DISCOVERY', enabled: true, reasonCode: null }],
    };
    component.profiles = [enabledInstagramProfile];
    component.selectedAuthVariant = 'INSTAGRAM_LOGIN';

    expect(component.selectedProfile?.enabled).toBe(true);
    expect(component.canContinue).toBe(false);
  });

  it('links to Autorizações and explains that new starts still depend on provider activation', async () => {
    const profile: MetaFlowProfile = {
      flowVariant: 'INSTAGRAM',
      authVariant: 'INSTAGRAM_LOGIN',
      enabled: true,
      reasonCode: null,
      capabilities: [{ operation: 'ASSET_DISCOVERY', enabled: true, reasonCode: null }],
    };
    const catalog = {
      reasonFor: vi.fn().mockReturnValue('Configuração disponível.'),
    };
    await TestBed.configureTestingModule({
      imports: [ConnectionDetailComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: EMPTY,
            snapshot: { queryParamMap: { get: () => null } },
          },
        },
        { provide: MetaFlowCatalogService, useValue: catalog },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ConnectionDetailComponent);
    fixture.componentInstance.profiles = [profile];
    fixture.componentInstance.selectedAuthVariant = profile.authVariant;
    fixture.componentInstance.isLoading = false;
    fixture.detectChanges();

    const view = fixture.nativeElement as HTMLElement;
    expect(view.querySelector('button')?.disabled).toBe(true);
    expect(view.querySelector('a[routerLink="/onboarding"]')?.textContent?.trim()).toBe('Autorizações');
    expect(view.textContent).toContain('o início de novas autorizações depende da ativação do provedor');
    fixture.destroy();
  });
});
