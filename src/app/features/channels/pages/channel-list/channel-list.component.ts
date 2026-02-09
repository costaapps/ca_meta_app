import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MetaIntegrationService } from '../../../../core/services/meta-integration.service';

export interface ConnectedChannel {
  id: number;
  type: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP';
  externalId: string;    // Antigo pageId ou accountId
  name: string;          // Antigo pageName ou username
  profilePicture: string;
  privateWelcomeMessage?: string;
  commentPublicReply?: string; // Novo
  commentPrivateReply?: string; // Novo
  connectedAt: string;
}

@Component({
  selector: 'app-channel-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './channel-list.component.html',
  styleUrls: ['./channel-list.component.scss']
})
export class ChannelListComponent implements OnInit, OnDestroy {
  connectedChannels: ConnectedChannel[] = [];
  isLoading = true;
  isSavingMessage: { [key: number]: boolean } = {};
  showSuccessModal = false;
  showErrorModal = false;
  successMessage = '';
  errorMessage = '';
  
  private destroy$ = new Subject<void>();

  constructor(
    private metaService: MetaIntegrationService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadConnectedChannels();
  }

  /**
   * Carrega os canais já conectados do backend
   */
  private loadConnectedChannels(): void {
    this.metaService.getConnectedChannels()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (channels: ConnectedChannel[]) => {
          this.connectedChannels = channels;
          this.isLoading = false;
          // Força detecção de mudanças para garantir atualização da view
          this.cdr.markForCheck();
        },
        error: (err: any) => {
          console.error('Erro ao carregar canais:', err);
          this.isLoading = false;
          // Força detecção de mudanças mesmo em caso de erro
          this.cdr.markForCheck();
        }
      });
  }

  /**
   * Saves the automation messages for a channel
   * Different configurations apply based on channel type:
   * - Instagram/Facebook: All three message types (private, public, private reply)
   * - WhatsApp: Only private welcome message
   */
  saveChannelConfiguration(channel: ConnectedChannel): void {
    if (!this.isChannelConfigValid(channel)) {
      this.showErrorToast('Please enter at least one message.');
      return;
    }

    this.isSavingMessage[channel.id] = true;
    
    this.metaService.saveAutoReply(channel)
    .pipe(takeUntil(this.destroy$))
    .subscribe({
      next: () => {
        this.isSavingMessage[channel.id] = false;
        this.showSuccessToast('Channel configuration saved successfully!');
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        console.error('Error saving channel configuration:', err);
        this.isSavingMessage[channel.id] = false;
        this.showErrorToast('Error saving configuration. Please try again.');
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Validates if at least one message field is filled based on channel type
   */
  private isChannelConfigValid(channel: ConnectedChannel): any {
    const hasPrivateWelcome = channel.privateWelcomeMessage?.trim();
    
    if (channel.type === 'WHATSAPP') {
      // WhatsApp only requires privateWelcomeMessage
      return hasPrivateWelcome;
    }
    
    // Instagram and Facebook can have any of the three fields filled
    const hasPublicReply = channel.commentPublicReply?.trim();
    const hasPrivateReply = channel.commentPrivateReply?.trim();
    
    return hasPrivateWelcome || hasPublicReply || hasPrivateReply;
  }

  /**
   * Checks if a channel type should display comment reply fields
   */
  shouldShowCommentReplies(channelType: string): boolean {
    return channelType === 'INSTAGRAM' || channelType === 'FACEBOOK';
  }

  /**
   * Shows success modal and auto-hides after 3 seconds
   */
  private showSuccessToast(message: string): void {
    this.successMessage = message;
    this.showSuccessModal = true;
    setTimeout(() => {
      this.showSuccessModal = false;
      this.cdr.markForCheck();
    }, 3000);
  }

  /**
   * Shows error modal and auto-hides after 4 seconds
   */
  private showErrorToast(message: string): void {
    this.errorMessage = message;
    this.showErrorModal = true;
    setTimeout(() => {
      this.showErrorModal = false;
      this.cdr.markForCheck();
    }, 4000);
  }

  /**
   * Closes success modal manually
   */
  closeSuccessModal(): void {
    this.showSuccessModal = false;
  }

  /**
   * Closes error modal manually
   */
  closeErrorModal(): void {
    this.showErrorModal = false;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
