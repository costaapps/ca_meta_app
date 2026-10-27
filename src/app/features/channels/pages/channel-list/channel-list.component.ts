import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ConnectedChannel } from '../../../../core/models/channel.model';
import { MetaIntegrationService } from '../../../../core/services/meta-integration.service';
import { NotificationBellComponent } from '../../components/notification-bell/notification-bell.component';

@Component({
  selector: 'app-channel-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, NotificationBellComponent],
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
   * Salva as mensagens de automação do canal.
   * Instagram/Facebook aceitam os três tipos de mensagem; WhatsApp usa boas-vindas privada.
   */
  saveChannelConfiguration(channel: ConnectedChannel): void {
    if (!this.isChannelConfigValid(channel)) {
      this.showErrorToast('Informe pelo menos uma mensagem.');
      return;
    }

    this.isSavingMessage[channel.id] = true;
    
    this.metaService.saveAutoReply(channel)
    .pipe(takeUntil(this.destroy$))
    .subscribe({
      next: () => {
        this.isSavingMessage[channel.id] = false;
        this.showSuccessToast('Configuração do canal salva com sucesso.');
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        console.error('Erro ao salvar configuração do canal:', err);
        this.isSavingMessage[channel.id] = false;
        this.showErrorToast('Erro ao salvar a configuração. Tente novamente.');
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Valida se pelo menos um campo de mensagem foi preenchido para o tipo de canal.
   */
  private isChannelConfigValid(channel: ConnectedChannel): any {
    const hasPrivateWelcome = channel.privateWelcomeMessage?.trim();
    
    if (channel.type === 'WHATSAPP') {
      return hasPrivateWelcome;
    }
    
    const hasPublicReply = channel.commentPublicReply?.trim();
    const hasPrivateReply = channel.commentPrivateReply?.trim();
    
    return hasPrivateWelcome || hasPublicReply || hasPrivateReply;
  }

  /**
   * Verifica se o canal deve exibir respostas para comentários.
   */
  shouldShowCommentReplies(channelType: string): boolean {
    return channelType === 'INSTAGRAM' || channelType === 'FACEBOOK';
  }

  /**
   * Exibe o modal de sucesso e fecha automaticamente após 3 segundos.
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
   * Exibe o modal de erro e fecha automaticamente após 4 segundos.
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
   * Fecha o modal de sucesso manualmente.
   */
  closeSuccessModal(): void {
    this.showSuccessModal = false;
  }

  /**
   * Fecha o modal de erro manualmente.
   */
  closeErrorModal(): void {
    this.showErrorModal = false;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
