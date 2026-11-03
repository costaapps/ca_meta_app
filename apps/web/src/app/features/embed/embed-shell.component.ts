import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { EmbedBridgeService, type EmbedBridgeSnapshot } from '../../core/embed/embed-bridge.service';
import { embedRoutePath, type EmbedNavigationRequest } from '../../core/embed/embed-contract';

@Component({
  selector: 'app-embed-shell',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './embed-shell.component.html',
  styleUrl: './embed-shell.component.scss',
})
export class EmbedShellComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('shell', { static: true }) private shell!: ElementRef<HTMLElement>;

  snapshot: EmbedBridgeSnapshot;
  private stopState?: () => void;
  private stopNavigation?: () => void;
  private resizeObserver?: ResizeObserver;

  constructor(private readonly bridge: EmbedBridgeService, private readonly router: Router) {
    this.snapshot = bridge.getSnapshot();
  }

  ngOnInit(): void {
    this.stopState = this.bridge.subscribe((snapshot) => { this.snapshot = snapshot; });
    this.stopNavigation = this.bridge.subscribeNavigation((request) => this.navigate(request));
    void this.bridge.start();
  }

  ngAfterViewInit(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (typeof height === 'number') this.bridge.sendResize(height);
    });
    this.resizeObserver.observe(this.shell.nativeElement);
  }

  requestTopLevel(): void {
    this.bridge.requestNavigation('top-level');
  }

  ngOnDestroy(): void {
    this.stopState?.();
    this.stopNavigation?.();
    this.resizeObserver?.disconnect();
    this.bridge.dispose();
  }

  private navigate(request: EmbedNavigationRequest): void {
    void this.router.navigateByUrl(embedRoutePath(request.route));
  }
}
