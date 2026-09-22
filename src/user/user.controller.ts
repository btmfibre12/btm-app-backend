import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  ParseFloatPipe,
  Logger,
} from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GetUser } from '../auth/get-user.decorator';
import { User } from '../entities/user.entity';
import { UpdateUserRoleDto } from '../dto/update-user-role.dto';
import { UpdateAvailabilityDto } from '../dto/update-availability.dto';
import { UpdateUserStatusDto } from '../dto/update-user-status.dto';
import { UpdateLocationDto } from '../dto/update-location.dto';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UserController {
  constructor(private userService: UserService) {}

  private readonly logger = new Logger('UserController');

  /**
   * GET /users/me
   * Returns the current user's fresh approval and active status.
   * Used by the frontend to poll and reflect approval without logout.
   */
  @Get('me')
  @Roles('admin', 'technician', 'client')
  getMe(@GetUser() user: User) {
    return this.userService.findById(user.id).then((u) => ({
      id: u.id,
      fullName: u.fullName,
      role: u.role,
      isActive: u.isActive,
      approvalStatus: u.approvalStatus,
    }));
  }

  @Get('technicians')
  @Roles('admin')
  getAllTechnicians() {
    return this.userService.getAllTechnicians();
  }

  @Get('clients')
  @Roles('admin')
  getAllClients() {
    return this.userService.getAllClients();
  }

  @Get()
  @Roles('admin')
  getAllUsers() {
    return this.userService.getAllUsers();
  }

  @Put(':id/status')
  @Roles('admin')
  updateUserStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.userService.updateUserStatus(id, dto.isActive);
  }

  @Put(':id/role')
  @Roles('admin')
  updateUserRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.userService.updateUserRole(id, dto.role);
  }

  @Put(':id/availability')
  @Roles('admin', 'technician')
  updateAvailability(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.userService.updateTechnicianAvailability(id, dto.isAvailable);
  }

  @Get(':id/jobs')
  @Roles('admin')
  getUserJobs(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getUserJobs(id);
  }

  @Patch(':id/activate')
  @Roles('admin')
  activateUser(@Param('id', ParseIntPipe) id: number) {
    return this.userService.setUserActiveStatus(id, true);
  }

  @Patch(':id/deactivate')
  @Roles('admin')
  deactivateUser(@Param('id', ParseIntPipe) id: number) {
    return this.userService.setUserActiveStatus(id, false);
  }

  @Put(':id/approvalStatus')
  @Roles('admin')
  updateUserApprovalStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.userService.updateUserApprovalStatus(id, dto);
  }

  // ─── LOCATION ENDPOINTS ───────────────────────────────────────────────────

  /**
   * PATCH /users/me/location
   * Technician sends their current GPS coordinates.
   * Called on login or when they toggle availability ON.
   */
  @Patch('me/location')
  @Roles('technician')
  updateMyLocation(
    @GetUser() user: User,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.userService.updateLocation(user.id, dto);
  }

  /**
   * PATCH /users/push-token
   * Saves the Expo push token for the current user (any role).
   */
  @Patch('push-token')
  @Roles('admin', 'technician', 'client')
  updatePushToken(
    @GetUser() user: User,
    @Body('expoPushToken') expoPushToken: string,
  ) {
    this.logger.log(`[PATCH /users/push-token] userId=${user.id} token=${expoPushToken ?? 'empty'}`);
    return this.userService.updatePushToken(user.id, expoPushToken);
  }

  /**
   * PATCH /users/me/bank-details
   * Technician saves their bank details for payout.
   */
  @Patch('me/bank-details')
  @Roles('technician')
  updateBankDetails(
    @GetUser() user: User,
    @Body() dto: { bankName: string; bankAccountNumber: string; bankAccountHolder: string },
  ) {
    return this.userService.updateBankDetails(user.id, dto);
  }

  /**
   * GET /users/nearest-technicians?lat=XX&lng=YY&limit=5
   * Returns available technicians sorted by distance from given coordinates.
   * Used by admin when assigning a job.
   */
  @Get('nearest-technicians')
  @Roles('admin', 'client')
  getNearestTechnicians(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
    @Query('limit') limit?: number,
  ) {
    return this.userService.getNearestTechnicians(lat, lng, limit ? Number(limit) : 5);
  }

  @Get(':id')
  @Roles('admin')
  findUserById(@Param('id', ParseIntPipe) id: number) {
    return this.userService.findById(id);
  }
}