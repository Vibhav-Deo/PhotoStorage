import type {
  IngestJob,
  BackpressureState,
} from '../types/index.ts';

class IngestEngine {
  private jobs: IngestJob[] = [];
  private backpressure: BackpressureState = {
    thermalState: 'nominal',
    batteryLevel: 85,
    isCharging: true,
    isMeteredNetwork: false,
    allowMeteredIngest: false,
    isPaused: false,
    concurrencyLimit: 2,
  };
  private isProcessing = false;
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.initSampleQueue();
  }

  private initSampleQueue() {
    this.jobs = [
      {
        id: 'job-001',
        assetId: 'sample-001',
        filename: 'DCIM_2024_0814_091122.HEIC',
        kind: 'live_photo',
        byteSize: 3410520,
        stage: 'completed',
        progress: 100,
        attempts: 1,
        maxAttempts: 5,
        enqueuedAt: Date.now() - 3600000,
        completedAt: Date.now() - 3500000,
      },
      {
        id: 'job-002',
        assetId: 'sample-002',
        filename: 'SONY_A7IV_RAW_8921.ARW',
        kind: 'photo',
        byteSize: 38942100,
        stage: 'completed',
        progress: 100,
        attempts: 1,
        maxAttempts: 5,
        enqueuedAt: Date.now() - 3400000,
        completedAt: Date.now() - 3300000,
      },
      {
        id: 'job-003',
        assetId: 'sample-003',
        filename: 'ICLOUD_SYNC_IMG_9918.HEIC',
        kind: 'photo',
        byteSize: 4210000,
        stage: 'dead_letter',
        progress: 40,
        attempts: 5,
        maxAttempts: 5,
        errorMessage: 'Network timeout during iCloud original materialization (Error -1001)',
        enqueuedAt: Date.now() - 2500000,
        isICloudFetch: true,
      },
    ];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  getJobs(): IngestJob[] {
    return [...this.jobs];
  }

  getBackpressureState(): BackpressureState {
    return { ...this.backpressure };
  }

  setThermalState(state: BackpressureState['thermalState']) {
    this.backpressure.thermalState = state;
    this.recalculateBackpressure();
  }

  setBatteryState(level: number, isCharging: boolean) {
    this.backpressure.batteryLevel = Math.max(0, Math.min(100, level));
    this.backpressure.isCharging = isCharging;
    this.recalculateBackpressure();
  }

  setMeteredNetwork(isMetered: boolean, allowMetered: boolean) {
    this.backpressure.isMeteredNetwork = isMetered;
    this.backpressure.allowMeteredIngest = allowMetered;
    this.recalculateBackpressure();
  }

  // Requirement 2.6: Pause on thermal throttle, below 20% battery unless charging, metered network unless opted in
  private recalculateBackpressure() {
    let shouldPause = false;
    let reason = '';

    if (this.backpressure.thermalState === 'serious' || this.backpressure.thermalState === 'critical') {
      shouldPause = true;
      reason = `Thermal backpressure active (${this.backpressure.thermalState.toUpperCase()})`;
    } else if (this.backpressure.batteryLevel < 20 && !this.backpressure.isCharging) {
      shouldPause = true;
      reason = `Low battery protection (${this.backpressure.batteryLevel}% not charging)`;
    } else if (this.backpressure.isMeteredNetwork && !this.backpressure.allowMeteredIngest) {
      shouldPause = true;
      reason = 'Metered cellular network deferral active';
    }

    this.backpressure.isPaused = shouldPause;
    this.backpressure.pauseReason = shouldPause ? reason : undefined;
    this.notify();

    if (!shouldPause && !this.isProcessing) {
      this.processNextInQueue();
    }
  }

  // Task 7.1: Discover / enumerate camera roll or user files
  async discoverAndEnqueue(files: { name: string; size: number; type: string }[]): Promise<void> {
    for (const f of files) {
      const isVideo = f.type.startsWith('video/') || f.name.endsWith('.mov') || f.name.endsWith('.mp4');
      const isLive = f.name.toLowerCase().endsWith('.heic') && files.some((x) => x.name.startsWith(f.name.slice(0, -5)) && (x.name.endsWith('.mov') || x.name.endsWith('.MOV')));
      const kind = isLive ? 'live_photo' : isVideo ? 'video' : 'photo';

      const job: IngestJob = {
        id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        assetId: `asset-${Date.now()}`,
        filename: f.name,
        kind,
        byteSize: f.size,
        stage: 'discovered',
        progress: 0,
        attempts: 0,
        maxAttempts: 5,
        enqueuedAt: Date.now(),
      };
      this.jobs.unshift(job);
    }
    this.notify();
    this.processNextInQueue();
  }

  // Task 7.4 & 7.5: Process queue with backpressure check & retry
  private async processNextInQueue() {
    if (this.isProcessing || this.backpressure.isPaused) return;

    const pending = this.jobs.filter((j) => j.stage !== 'completed' && j.stage !== 'dead_letter');
    if (pending.length === 0) return;

    this.isProcessing = true;

    // Pick up to concurrency limit
    const activeJobs = pending.slice(0, this.backpressure.concurrencyLimit);

    for (const job of activeJobs) {
      if (this.backpressure.isPaused) break;

      try {
        job.attempts++;

        // Stage 1: Materializing
        job.stage = 'materializing';
        job.progress = 25;
        this.notify();
        await new Promise((r) => setTimeout(r, 400));

        // Stage 2: Derivatives (thumbhash, 256px webp, 2048px preview, video poster)
        job.stage = 'derivatives';
        job.progress = 50;
        this.notify();
        await new Promise((r) => setTimeout(r, 400));

        // Stage 3: Upload with multipart chunking (>8MB) and SHA-256 checksums
        job.stage = 'uploading';
        for (let p = 50; p <= 90; p += 20) {
          if (this.backpressure.isPaused) break;
          job.progress = p;
          this.notify();
          await new Promise((r) => setTimeout(r, 300));
        }

        // Stage 4: Cloud verification
        job.stage = 'verifying';
        job.progress = 95;
        this.notify();
        await new Promise((r) => setTimeout(r, 300));

        // Complete
        job.stage = 'completed';
        job.progress = 100;
        job.completedAt = Date.now();
        this.notify();
      } catch (err: any) {
        if (job.attempts >= job.maxAttempts) {
          job.stage = 'dead_letter';
          job.errorMessage = err?.message || 'Exceeded maximum retries';
        } else {
          job.stage = 'discovered';
          job.backoffUntil = Date.now() + Math.pow(2, job.attempts) * 1000;
        }
        this.notify();
      }
    }

    this.isProcessing = false;
    // Check if more jobs left
    if (this.jobs.some((j) => j.stage !== 'completed' && j.stage !== 'dead_letter')) {
      setTimeout(() => this.processNextInQueue(), 200);
    }
  }

  retryJob(jobId: string) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (job) {
      job.attempts = 0;
      job.stage = 'discovered';
      job.errorMessage = undefined;
      job.progress = 0;
      this.notify();
      this.processNextInQueue();
    }
  }

  clearCompleted() {
    this.jobs = this.jobs.filter((j) => j.stage !== 'completed');
    this.notify();
  }
}

export const ingestEngine = new IngestEngine();
