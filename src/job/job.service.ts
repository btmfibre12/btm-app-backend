import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from '../entities/job.entity';
import { User } from '../entities/user.entity';
import { JobStatus } from '../job/job-status.enum';
import { CreateJobDto } from '../dto/create-job.dto';
import { PaymentStatus } from '../payment/payment-status.enum';
import { ServiceItem } from '../entities/service-item.entity';
import { RateJobDto } from '../dto/rate-job.dto';
import { PushNotificationService } from './push-notification.service';
import { NotificationService } from '../notification/notification.service';
import { ApprovalStatus } from '../user/approval-status.enum';

const JOB_RADIUS_KM = 75;
const PAYOUT_FLOOR = 500;

@Injectable()
export class JobService {
  constructor(
    @InjectRepository(Job)
    private jobsRepo: Repository<Job>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(ServiceItem)
    private serviceItemRepo: Repository<ServiceItem>,
    private pushService: PushNotificationService,
    private notificationService: NotificationService,
  ) {}

  // ─── CREATE JOB ─────────────────────────────────────────────────────────
  async createJob(actor: User, dto: CreateJobDto, clientImagePaths: string[] = []) {
    const requester = await this.userRepo.findOne({ where: { id: actor.id } });
    if (!requester) throw new NotFoundException('User not found');

    let bookingClient: User;
    let manualClientName: string | null = null;
    let manualClientSurname: string | null = null;
    let manualClientEmail: string | null = null;
    let manualClientPhone: string | null = null;

    if (requester.role === 'admin') {
      const requestedClientId = dto.clientId != null ? Number(dto.clientId) : null;

      if (requestedClientId && !Number.isNaN(requestedClientId)) {
        const selectedClient = await this.userRepo.findOne({
          where: { id: requestedClientId, role: 'client' },
        });
        if (!selectedClient) {
          throw new NotFoundException('Selected client not found');
        }
        if (!selectedClient.isActive || selectedClient.approvalStatus !== 'APPROVED') {
          throw new ForbiddenException('Selected client is not active/approved yet.');
        }
        bookingClient = selectedClient;
      } else {
        const name = dto.manualClientName?.trim();
        const surname = dto.manualClientSurname?.trim();
        const email = dto.manualClientEmail?.trim();
        const phone = dto.manualClientPhone?.trim();
        if (!name || !surname || !phone) {
          throw new BadRequestException(
            'Manual client details are required (name, surname, phone) when no client account is selected.',
          );
        }

        // WhatsApp/manual booking fallback when no app client account is selected.
        bookingClient = requester;
        manualClientName = name;
        manualClientSurname = surname;
        manualClientEmail = email || null;
        manualClientPhone = phone;
      }
    } else {
      if (!requester.isActive || requester.approvalStatus !== 'APPROVED') {
        throw new ForbiddenException('Your account is pending approval. You cannot create jobs yet.');
      }
      bookingClient = requester;
    }

    const serviceItem = await this.serviceItemRepo.findOne({ where: { id: dto.serviceItemId } });
    if (!serviceItem) throw new NotFoundException('Service item not found');

    const { clientId: _ignoredClientId, ...jobInput } = dto;

    const job = this.jobsRepo.create({
      ...jobInput,
      client: bookingClient,
      manualClientName,
      manualClientSurname,
      manualClientEmail,
      manualClientPhone,
      status: JobStatus.PENDING,
      serviceItem,
      clientLatitude: dto.clientLatitude ?? null,
      clientLongitude: dto.clientLongitude ?? null,
      clientImages: clientImagePaths,
      beforeImages: null as any,
      afterImages: null as any,
    });

    return this.jobsRepo.save(job);
  }

  notifyTechnician(tech: User, job: Job) {
    console.log(`Notify ${tech.fullName} about job ${job.id}`);
  }

  // ─── TECHNICIAN ACCEPT JOB ───────────────────────────────────────────────
  async acceptJob(technician: User, jobId: number) {
    const freshTech = await this.userRepo.findOne({ where: { id: technician.id } });

    if (!freshTech || !freshTech.isActive || freshTech.approvalStatus !== 'APPROVED' || !freshTech.isAvailable) {
      throw new ForbiddenException('Technician not available');
    }

    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician', 'payment', 'serviceItem'],
    });

    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.PENDING) throw new ForbiddenException('Job not available');
    if (job.technician && job.technician.id !== freshTech.id) {
      throw new ForbiddenException('This job is already assigned to another technician');
    }

    // 🔐 PAYMENT GATE
    if (!job.payment || job.payment.status !== PaymentStatus.PAID) {
      throw new ForbiddenException('Job not dispatchable');
    }

    // Allow technician self-claim if job is still unassigned.
    if (!job.technician) {
      job.technician = freshTech;
      job.dispatchedAt = new Date();
    }

    job.status = JobStatus.ACCEPTED;
    job.acceptedAt = new Date();

    // Lock payout if not already locked
    if (job.clientPrice != null && job.serviceItem?.technicianPercentage != null && !job.payoutLocked) {
      const pct = job.serviceItem.technicianPercentage;
      job.technicianPercentage = pct;
      job.technicianPayout = Math.max(job.clientPrice * pct, 500);
      job.payoutLocked = true;
      job.dispatchedAt = new Date();
    }

    return this.jobsRepo.save(job);
  }

  // ─── TECHNICIAN DECLINE JOB ──────────────────────────────────────────────
  async declineJob(technician: User, jobId: number) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician', 'declinedBy'],
    });

    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.PENDING) throw new ForbiddenException('Cannot decline');
    if (job.technician && job.technician.id !== technician.id) {
      throw new ForbiddenException('Cannot decline a job assigned to another technician');
    }

    if (!job.declinedBy) job.declinedBy = [];
    if (!job.declinedBy.some((u) => u.id === technician.id)) {
      job.declinedBy.push(technician);
    }

    if (job.technician?.id === technician.id) {
      job.technician = null;
    }

    return this.jobsRepo.save(job);
  }

  // ─── GET JOBS FOR USER ───────────────────────────────────────────────────
  async getMyJobs(user: User) {
    if (user.role === 'client') {
      return this.jobsRepo.find({
        where: { client: { id: user.id } },
        relations: ['technician', 'client', 'payment'],
      });
    } else if (user.role === 'technician') {
      return this.jobsRepo.find({
        where: { technician: { id: user.id } },
        relations: ['technician', 'client'],
      });
    }
    return [];
  }

  // ─── GET PENDING JOBS FOR THIS TECHNICIAN ────────────────────────────────
  // Returns:
  //   a) Jobs explicitly assigned to this tech (no radius restriction)
  //   b) Unassigned paid-pending jobs within JOB_RADIUS_KM of the technician
  //      (or all unassigned if tech has no location set)
  async getAssignedJobs(technician: User) {
    const freshTech = await this.userRepo.findOne({ where: { id: technician.id } });
    if (!freshTech) throw new NotFoundException('Technician not found');
    if (!freshTech.isActive || freshTech.approvalStatus !== 'APPROVED') {
      return [];
    }

    const jobs = await this.jobsRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.client', 'client')
      .leftJoinAndSelect('job.technician', 'technician')
      .leftJoinAndSelect('job.payment', 'payment')
      .leftJoinAndSelect('job.serviceItem', 'serviceItem')
      .leftJoinAndSelect('job.declinedBy', 'declinedBy')
      .where('job.status = :status', { status: JobStatus.PENDING })
      .andWhere('(technician.id = :techId OR technician.id IS NULL)', { techId: technician.id })
      .andWhere('payment.status = :paid', { paid: PaymentStatus.PAID })
      .orderBy('job.id', 'DESC')
      .getMany();

    // Filter out declined
    const notDeclined = jobs.filter(
      (job) => !job.declinedBy?.some((u) => u.id === technician.id),
    );

    // For unassigned jobs, apply radius filter if the technician has a location
    const techLat = freshTech.latitude;
    const techLng = freshTech.longitude;
    const hasLocation = techLat != null && techLng != null;

    return notDeclined.filter((job) => {
      // Admin-assigned to this tech — always show
      if (job.technician?.id === technician.id) return true;

      // Unassigned job with no client location — show to all techs
      if (job.clientLatitude == null || job.clientLongitude == null) return true;

      // Unassigned job: apply radius only if tech has location
      if (!hasLocation) return true; // tech has no location set yet — show all

      const distKm = this.haversineKm(
        techLat!,
        techLng!,
        job.clientLatitude,
        job.clientLongitude,
      );
      return distKm <= JOB_RADIUS_KM;
    });
  }

  // ─── ADMIN: TECHNICIANS WITHIN JOB RADIUS ────────────────────────────────
  async getAssignableTechnicians(jobId: number) {
    const job = await this.jobsRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    // Radius filtering is based on job/client coordinates.
    if (job.clientLatitude == null || job.clientLongitude == null) {
      return [];
    }

    const technicians = await this.userRepo.find({
      where: {
        role: 'technician',
        isActive: true,
        approvalStatus: ApprovalStatus.APPROVED,
      },
    });

    return technicians
      .filter((tech) => tech.latitude != null && tech.longitude != null)
      .map((tech) => {
        const distanceKm = this.haversineKm(
          Number(tech.latitude),
          Number(tech.longitude),
          Number(job.clientLatitude),
          Number(job.clientLongitude),
        );
        return { ...tech, distanceKm };
      })
      .filter((tech) => tech.distanceKm <= JOB_RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  // ─── ADMIN: GET ALL JOBS ─────────────────────────────────────────────────
  async getAllJobs() {
    return this.jobsRepo.find({
      relations: ['client', 'technician'],
      order: { id: 'DESC' },
    });
  }

  // ─── STATUS TRANSITION ───────────────────────────────────────────────────
  private readonly validTransitions = {
    [JobStatus.ACCEPTED]: [JobStatus.IN_PROGRESS],
    [JobStatus.IN_PROGRESS]: [JobStatus.COMPLETED],
    [JobStatus.COMPLETED]: [JobStatus.CLOSED],
  };

  async updateJobStatus(jobId: number, newStatus: JobStatus) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['payment'],
    });
    if (!job) throw new NotFoundException('Job not found');

    const allowed = this.validTransitions[job.status];
    if (!allowed?.includes(newStatus)) {
      throw new ForbiddenException('Invalid job status transition');
    }

    if (job.status === JobStatus.PENDING && newStatus === JobStatus.ACCEPTED) {
      if (!job.payment || job.payment.status !== PaymentStatus.PAID) {
        throw new ForbiddenException('Payment must be completed before accepting this job.');
      }
    }

    job.status = newStatus;
    return this.jobsRepo.save(job);
  }

  // ─── ADMIN: ASSIGN TECHNICIAN (no auto-accept — stays PENDING) ───────────
  async assignTechnician(jobId: number, technicianId: number) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician', 'client', 'serviceItem'],
    });
    if (!job) throw new NotFoundException('Job not found');

    const tech = await this.userRepo.findOne({
      where: { id: technicianId, role: 'technician', isActive: true },
    });
    if (!tech) throw new NotFoundException('Technician not found or inactive');

    if (job.clientLatitude == null || job.clientLongitude == null) {
      throw new BadRequestException('Job location is required before assigning a technician.');
    }
    if (tech.latitude == null || tech.longitude == null) {
      throw new BadRequestException('Selected technician has no location set.');
    }

    const distanceKm = this.haversineKm(
      Number(tech.latitude),
      Number(tech.longitude),
      Number(job.clientLatitude),
      Number(job.clientLongitude),
    );
    if (distanceKm > JOB_RADIUS_KM) {
      throw new ForbiddenException(`Technician is outside the ${JOB_RADIUS_KM}km assignment radius.`);
    }

    job.technician = tech;
    // ✅ Status stays PENDING — tech must accept explicitly
    // Do NOT set job.status = JobStatus.ACCEPTED here

    // Pre-calculate payout so technician sees amount before accepting
    if (job.clientPrice != null && job.serviceItem?.technicianPercentage != null) {
      const pct = job.serviceItem.technicianPercentage;
      job.technicianPercentage = pct;
      job.technicianPayout = Math.max(job.clientPrice * pct, PAYOUT_FLOOR);
      job.payoutLocked = true;
      job.dispatchedAt = new Date();
    }

    const saved = await this.jobsRepo.save(job);

    // 🔔 Notify technician of new assignment
    await this.pushService.sendPush(
      tech.expoPushToken,
      '📋 New Job Assigned',
      `You have been assigned job: ${job.title}. Please accept or decline.`,
      { jobId: job.id },
    );

    await this.notificationService.createForUser(
      tech,
      'New Job Assigned',
      `You have been assigned job: ${job.title}. Please accept or decline.`,
      'job_assigned',
      { jobId: job.id },
    );

    return saved;
  }

  // ─── PAYOUT: TECHNICIAN REQUESTS PAYOUT ──────────────────────────────────
  async requestPayout(technician: User, jobId: number) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician'],
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.technician?.id !== technician.id) throw new ForbiddenException('Not your job');
    if (job.status !== JobStatus.CLOSED) throw new BadRequestException('Job must be closed to request payout');
    if (job.payoutStatus !== 'none') throw new BadRequestException('Payout already requested');

    job.payoutStatus = 'requested';
    return this.jobsRepo.save(job);
  }

  // ─── PAYOUT: ADMIN APPROVES PAYOUT ───────────────────────────────────────
  async approvePayout(jobId: number) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician'],
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.payoutStatus !== 'requested') throw new BadRequestException('No pending payout request');

    job.payoutStatus = 'approved';
    const saved = await this.jobsRepo.save(job);

    // 🔔 Notify technician
    await this.pushService.sendPush(
      job.technician?.expoPushToken,
      '✅ Payout Approved',
      `Your payout of R${job.technicianPayout} for "${job.title}" has been approved. Payment is on the way.`,
      { jobId: job.id },
    );

    if (job.technician) {
      await this.notificationService.createForUser(
        job.technician,
        'Payout Approved',
        `Your payout of R${job.technicianPayout} for "${job.title}" has been approved. Payment is on the way.`,
        'payout_approved',
        { jobId: job.id },
      );
    }

    return saved;
  }

  // ─── PAYOUT: ADMIN MARKS AS PAID ─────────────────────────────────────────
  async markPayoutPaid(jobId: number) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician'],
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.payoutStatus !== 'approved') throw new BadRequestException('Payout not approved yet');

    job.payoutStatus = 'paid';
    const saved = await this.jobsRepo.save(job);

    // 🔔 Notify technician
    await this.pushService.sendPush(
      job.technician?.expoPushToken,
      '💰 Payout Paid',
      `Your payout of R${job.technicianPayout} for "${job.title}" has been paid.`,
      { jobId: job.id },
    );

    if (job.technician) {
      await this.notificationService.createForUser(
        job.technician,
        'Payout Paid',
        `Your payout of R${job.technicianPayout} for "${job.title}" has been paid.`,
        'payout_paid',
        { jobId: job.id },
      );
    }

    return saved;
  }


  async forceCloseJob(jobId: number) {
    const job = await this.jobsRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    job.status = JobStatus.CLOSED;
    return this.jobsRepo.save(job);
  }

  async filterJobs(filters: { status?: JobStatus; technicianId?: number; clientId?: number }) {
    const query = this.jobsRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.client', 'client')
      .leftJoinAndSelect('job.technician', 'technician');

    if (filters.status) query.andWhere('job.status = :status', { status: filters.status });
    if (filters.technicianId) query.andWhere('technician.id = :techId', { techId: filters.technicianId });
    if (filters.clientId) query.andWhere('client.id = :clientId', { clientId: filters.clientId });

    return query.orderBy('job.id', 'DESC').getMany();
  }

  async getJobById(jobId: number) {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['client', 'technician', 'payment', 'serviceItem'], // ← serviceItem added
    });

    if (!job) throw new NotFoundException('Job not found');

    return {
      ...job,
      paymentStatus: job.payment?.status ?? null,
    };
  }

  // ─── TECHNICIAN UPLOADS BEFORE IMAGES ────────────────────────────────────
  async addBeforeImages(jobId: number, beforeImagePaths: string[], technician: User): Promise<Job> {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician'],
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.technician?.id !== technician.id) {
      throw new ForbiddenException('Only the assigned technician can upload before photos.');
    }
    if (job.status !== JobStatus.ACCEPTED) {
      throw new BadRequestException('Job must be accepted to upload before photos.');
    }
    job.beforeImages = [...(job.beforeImages ?? []), ...beforeImagePaths];
    return this.jobsRepo.save(job);
  }

  // ─── TECHNICIAN UPLOADS AFTER IMAGES ─────────────────────────────────────
  async addAfterImages(jobId: number, afterImagePaths: string[], technician: User): Promise<Job> {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['technician'],
    });
    if (!job) throw new NotFoundException('Job not found');

    if (job.technician?.id !== technician.id) {
      throw new ForbiddenException('Only the assigned technician can upload after photos.');
    }
    if (job.status !== JobStatus.IN_PROGRESS) {
      throw new BadRequestException('Job must be in progress to upload after photos.');
    }

    job.afterImages = [...(job.afterImages ?? []), ...afterImagePaths];
    return this.jobsRepo.save(job);
  }

  // ─── CLIENT SUBMITS RATING ────────────────────────────────────────────────
  async submitRating(jobId: number, dto: RateJobDto, client: User): Promise<Job> {
    const job = await this.jobsRepo.findOne({
      where: { id: jobId },
      relations: ['client'],
    });
    if (!job) throw new NotFoundException('Job not found');

    if (job.client?.id !== client.id) {
      throw new ForbiddenException('Only the client who booked this job can rate it.');
    }
    if (job.status !== JobStatus.COMPLETED && job.status !== JobStatus.CLOSED) {
      throw new BadRequestException('You can only rate a completed job.');
    }
    if (job.rating != null) {
      throw new BadRequestException('This job has already been rated.');
    }

    job.rating = dto.rating;
    job.feedback = dto.feedback ?? null;
    return this.jobsRepo.save(job);
  }

  // ─── ADMIN: REVERT JOB TO PENDING ────────────────────────────────────────
  async revertToPending(jobId: number): Promise<Job> {
    const job = await this.jobsRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (!['accepted', 'in_progress'].includes(job.status)) {
      throw new BadRequestException('Only accepted or in_progress jobs can be reverted to pending.');
    }
    job.status = JobStatus.PENDING;
    job.technician = null;
    return this.jobsRepo.save(job);
  }

  // ─── HAVERSINE HELPER ─────────────────────────────────────────────────────
  private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10;
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }
}

