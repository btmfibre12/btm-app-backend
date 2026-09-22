import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { UserRole } from '../entities/user.entity';
import { UpdateUserStatusDto } from '../dto/update-user-status.dto';
import { UpdateLocationDto } from '../dto/update-location.dto';
import { Notification } from '../entities/notification.entity';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  private isExpoPushToken(token: string): boolean {
    return /^ExponentPushToken\[[^\]]+\]$/.test(token) || /^ExpoPushToken\[[^\]]+\]$/.test(token);
  }

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Notification)
    private notificationRepo: Repository<Notification>,
  ) {}

  getAllTechnicians(): Promise<User[]> {
    return this.usersRepository.find({
      where: { role: 'technician', isActive: true },
      select: ['id', 'fullName', 'email', 'phoneNumber', 'isAvailable', 'role', 'isActive'],
      order: { fullName: 'ASC' },
    });
  }

  getAllClients(): Promise<User[]> {
    return this.usersRepository.find({
      where: { role: 'client' },
      select: ['id', 'fullName', 'email', 'role'],
      order: { fullName: 'ASC' },
    });
  }

  getAllUsers(): Promise<User[]> {
    return this.usersRepository.find({
      select: ['id', 'fullName', 'email', 'phoneNumber', 'role', 'isAvailable', 'isActive', 'approvalStatus'],
      order: { id: 'ASC' },
    });
  }

  async updateUserStatus(userId: number, isActive: boolean): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    user.isActive = isActive;
    return this.usersRepository.save(user);
  }

  async updateUserRole(userId: number, role: UserRole): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    user.role = role;
    return this.usersRepository.save(user);
  }

  async updateTechnicianAvailability(userId: number, isAvailable: boolean): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== 'technician') throw new ForbiddenException('User is not a technician');
    if (!user.isActive && isAvailable) {
      throw new ForbiddenException('Inactive technicians cannot be set as available');
    }
    user.isAvailable = isAvailable;
    return this.usersRepository.save(user);
  }

  async getUserJobs(userId: number) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['clientJobs', 'technicianJobs'],
    });
    if (!user) throw new NotFoundException('User not found');
    return { clientJobs: user.clientJobs, technicianJobs: user.technicianJobs };
  }

  async setUserActiveStatus(userId: number, isActive: boolean) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const wasInactive = !user.isActive;
    user.isActive = isActive;
    const saved = await this.usersRepository.save(user);

    if (isActive && wasInactive && user.role !== 'admin') {
      const notification = this.notificationRepo.create({
        user: saved,
        title: '✅ Account Approved!',
        body: `Great news, ${user.fullName}! Your account has been approved by admin. You now have full access to BTM Fibre Connect.`,
        type: 'general',
        isRead: false,
        data: null,
      });
      await this.notificationRepo.save(notification);
    }

    return saved;
  }

  async findById(id: number): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUserApprovalStatus(userId: number, dto: UpdateUserStatusDto) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    user.approvalStatus = dto.approvalStatus;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    return this.usersRepository.save(user);
  }

  async updateLocation(userId: number, dto: UpdateLocationDto): Promise<{ message: string }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== 'technician') throw new ForbiddenException('Only technicians can update location');

    user.latitude = dto.latitude;
    user.longitude = dto.longitude;
    if (dto.areaLabel !== undefined) {
      user.lastSavedAreaLocation = dto.areaLabel?.trim() || undefined;
    }
    await this.usersRepository.save(user);

    return { message: 'Location updated successfully' };
  }

  async updatePushToken(userId: number, expoPushToken: string): Promise<{ message: string }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const normalizedToken = expoPushToken?.trim?.() ?? '';
    this.logger.log(`[updatePushToken] userId=${userId} passedToken=${normalizedToken || 'empty'}`);

    if (!normalizedToken) {
      user.expoPushToken = null as any;
      await this.usersRepository.save(user);
      this.logger.warn(`[updatePushToken] Cleared token for userId=${userId}`);
      return { message: 'Push token cleared' };
    }

    if (!this.isExpoPushToken(normalizedToken)) {
      this.logger.warn(`[updatePushToken] Invalid Expo push token for userId=${userId}: ${normalizedToken}`);
      throw new BadRequestException('Invalid Expo push token');
    }

    user.expoPushToken = normalizedToken;
    await this.usersRepository.save(user);
    this.logger.log(`[updatePushToken] Saved push token for userId=${userId}`);
    return { message: 'Push token saved' };
  }

  async getNearestTechnicians(
    clientLat: number,
    clientLng: number,
    limitCount = 5,
  ): Promise<Array<{ id: number; fullName: string; email: string; distanceKm: number; isAvailable: boolean }>> {
    const technicians = await this.usersRepository.find({
      where: { role: 'technician', isActive: true, isAvailable: true },
      select: ['id', 'fullName', 'email', 'latitude', 'longitude', 'isAvailable'],
    });

    const techsWithLocation = technicians.filter(
      (t) => t.latitude != null && t.longitude != null,
    );

    const withDistance = techsWithLocation.map((tech) => ({
      id: tech.id,
      fullName: tech.fullName,
      email: tech.email,
      isAvailable: tech.isAvailable,
      distanceKm: this.haversineKm(clientLat, clientLng, parseFloat(tech.latitude as any), parseFloat(tech.longitude as any)),
    }));

    return withDistance
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limitCount);
  }

  async updateBankDetails(userId: number, dto: { bankName: string; bankAccountNumber: string; bankAccountHolder: string }) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    user.bankName = dto.bankName;
    user.bankAccountNumber = dto.bankAccountNumber;
    user.bankAccountHolder = dto.bankAccountHolder;
    return this.usersRepository.save(user);
  }

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
    return deg * (Math.PI / 180);
  }
}