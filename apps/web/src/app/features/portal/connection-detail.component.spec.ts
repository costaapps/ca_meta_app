import { ActivatedRoute } from '@angular/router';
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
});
