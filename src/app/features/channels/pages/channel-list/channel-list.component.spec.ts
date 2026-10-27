import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ConnectedChannel } from '../../../../core/models/channel.model';
import { MetaIntegrationService } from '../../../../core/services/meta-integration.service';
import { ChannelListComponent } from './channel-list.component';

describe('ChannelListComponent', () => {
  let component: ChannelListComponent;
  let fixture: ComponentFixture<ChannelListComponent>;
  const getConnectedChannels = vi.fn();
  const saveAutoReply = vi.fn();
  const metaServiceMock = {
    getConnectedChannels,
    saveAutoReply
  } as Partial<MetaIntegrationService>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChannelListComponent],
      providers: [
        { provide: MetaIntegrationService, useValue: metaServiceMock },
        {
          provide: ActivatedRoute,
          useValue: { queryParams: of({}), snapshot: { data: {} } }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChannelListComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should load connected channels on init', () => {
    const mockChannels: ConnectedChannel[] = [
      {
        id: 1,
        type: 'WHATSAPP',
        externalId: 'pn_1',
        name: 'Main WhatsApp',
        profilePicture: '',
        connectedAt: '2026-01-01T00:00:00Z'
      }
    ];

    getConnectedChannels.mockReturnValue(of(mockChannels));

    fixture.detectChanges();

    expect(component.connectedChannels).toEqual(mockChannels);
    expect(getConnectedChannels).toHaveBeenCalledTimes(1);
  });

  it('should save channel configuration through the service', () => {
    const channel: ConnectedChannel = {
      id: 2,
      type: 'FACEBOOK',
      externalId: 'page_2',
      name: 'Main Page',
      profilePicture: '',
      privateWelcomeMessage: 'Hello',
      commentPublicReply: 'Thanks',
      commentPrivateReply: 'DM us',
      connectedAt: '2026-01-01T00:00:00Z'
    };

    saveAutoReply.mockReturnValue(of({ ok: true }));

    component.saveChannelConfiguration(channel);

    expect(saveAutoReply).toHaveBeenCalledWith(channel);
  });
});
