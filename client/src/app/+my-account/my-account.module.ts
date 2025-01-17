import { QRCodeModule } from 'angularx-qrcode'
import { AutoCompleteModule } from 'primeng/autocomplete'
import { TableModule } from 'primeng/table'
import { DragDropModule } from '@angular/cdk/drag-drop'
import { NgModule } from '@angular/core'
import { SharedAbuseListModule } from '@app/shared/shared-abuse-list'
import { SharedActorImageEditModule } from '@app/shared/shared-actor-image-edit'
import { SharedFormModule } from '@app/shared/shared-forms'
import { SharedGlobalIconModule } from '@app/shared/shared-icons'
import { SharedMainModule } from '@app/shared/shared-main'
import { SharedModerationModule } from '@app/shared/shared-moderation'
import { SharedShareModal } from '@app/shared/shared-share-modal'
import { SharedUserInterfaceSettingsModule } from '@app/shared/shared-user-settings'
import { SharedUsersModule } from '@app/shared/shared-users'
import { SharedActorImageModule } from '../shared/shared-actor-image/shared-actor-image.module'
import { MyAccountAbusesListComponent } from './my-account-abuses/my-account-abuses-list.component'
import { MyAccountApplicationsComponent } from './my-account-applications/my-account-applications.component'
import { MyAccountBlocklistComponent } from './my-account-blocklist/my-account-blocklist.component'
import { MyAccountServerBlocklistComponent } from './my-account-blocklist/my-account-server-blocklist.component'
import { MyAccountNotificationsComponent } from './my-account-notifications/my-account-notifications.component'
import { MyAccountRoutingModule } from './my-account-routing.module'
import { MyAccountChangeEmailComponent } from './my-account-settings/my-account-change-email'
import { MyAccountChangePasswordComponent } from './my-account-settings/my-account-change-password/my-account-change-password.component'
import { MyAccountDangerZoneComponent } from './my-account-settings/my-account-danger-zone'
import { MyAccountEmailPreferencesComponent } from './my-account-settings/my-account-email-preferences'
import { MyAccountNotificationPreferencesComponent } from './my-account-settings/my-account-notification-preferences'
import { MyAccountProfileComponent } from './my-account-settings/my-account-profile/my-account-profile.component'
import { MyAccountSettingsComponent } from './my-account-settings/my-account-settings.component'
import { MyAccountTwoFactorButtonComponent, MyAccountTwoFactorComponent } from './my-account-settings/my-account-two-factor'
import { MyAccountComponent } from './my-account.component'
import {
  MyAccountImportExportComponent,
  MyAccountExportComponent,
  MyAccountImportComponent,
  UserImportExportService
} from './my-account-import-export'
import { UploadProgressComponent } from '@app/shared/standalone-upload'

@NgModule({
  imports: [
    MyAccountRoutingModule,

    QRCodeModule,
    AutoCompleteModule,
    TableModule,
    DragDropModule,

    SharedMainModule,
    SharedFormModule,
    SharedModerationModule,
    SharedUserInterfaceSettingsModule,
    SharedUsersModule,
    SharedGlobalIconModule,
    SharedAbuseListModule,
    SharedShareModal,
    SharedActorImageModule,
    SharedActorImageEditModule,

    UploadProgressComponent
  ],

  declarations: [
    MyAccountComponent,
    MyAccountSettingsComponent,
    MyAccountChangePasswordComponent,
    MyAccountProfileComponent,
    MyAccountChangeEmailComponent,
    MyAccountApplicationsComponent,

    MyAccountTwoFactorButtonComponent,
    MyAccountTwoFactorComponent,

    MyAccountDangerZoneComponent,
    MyAccountBlocklistComponent,
    MyAccountAbusesListComponent,
    MyAccountServerBlocklistComponent,
    MyAccountNotificationsComponent,
    MyAccountNotificationPreferencesComponent,

    MyAccountEmailPreferencesComponent,
    MyAccountImportExportComponent,
    MyAccountExportComponent,
    MyAccountImportComponent
  ],

  exports: [
    MyAccountComponent
  ],

  providers: [
    UserImportExportService
  ]
})
export class MyAccountModule {
}
