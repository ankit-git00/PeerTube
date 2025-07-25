import { CdkStepperModule } from '@angular/cdk/stepper'
import { CommonModule } from '@angular/common'
import { Component, inject, model, OnInit } from '@angular/core'
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms'
import {
  BuildFormArgumentTyped,
  FormDefaultTyped,
  FormReactiveErrorsTyped,
  FormReactiveMessagesTyped
} from '@app/shared/form-validators/form-validator.model'
import { FormReactiveService } from '@app/shared/shared-forms/form-reactive.service'
import { SelectOptionsComponent } from '@app/shared/shared-forms/select/select-options.component'
import { ColorPickerModule } from 'primeng/colorpicker'
import { SelectOptionsItem } from 'src/types'
import { AuthType, EnabledDisabled, UsageType } from './usage-type.model'

type Form = {
  keepOriginalVideo: FormControl<EnabledDisabled>
  p2p: FormControl<EnabledDisabled>
  transcription: FormControl<EnabledDisabled>
  authType: FormControl<AuthType>
}

@Component({
  selector: 'my-institutional-config',
  templateUrl: './institutional-config.component.html',
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ColorPickerModule,
    CdkStepperModule,
    SelectOptionsComponent
  ]
})
export class InstitutionalConfigComponent implements OnInit {
  private formReactiveService = inject(FormReactiveService)

  usageType = model.required<UsageType>()

  form: FormGroup<Form>
  formErrors: FormReactiveErrorsTyped<Form> = {}
  validationMessages: FormReactiveMessagesTyped<Form> = {}

  p2pOptions: SelectOptionsItem<EnabledDisabled>[] = [
    {
      id: 'enabled',
      label: 'Enabled',
      description: 'Enable P2P streaming by default for anonymous and new users'
    },
    {
      id: 'disabled',
      label: 'Disabled',
      description: 'Disable P2P streaming'
    }
  ]

  transcriptionOptions: SelectOptionsItem<EnabledDisabled>[] = [
    {
      id: 'enabled',
      label: 'Enabled',
      description: 'Enable automatic transcription of videos to automatically generate subtitles'
    },
    {
      id: 'disabled',
      label: 'Disabled',
      description: 'Disable automatic transcription of videos'
    }
  ]

  keepOriginalVideoOptions: SelectOptionsItem<EnabledDisabled>[] = [
    {
      id: 'enabled',
      label: 'Yes',
      description: 'Keep the original video file on the server'
    },
    {
      id: 'disabled',
      label: 'No',
      description: 'Delete the original video file after processing'
    }
  ]

  authenticationOptions: SelectOptionsItem<AuthType>[] = [
    {
      id: 'local',
      label: 'Disabled',
      description: 'Your platform will manage user registration and login internally'
    },
    {
      id: 'ldap',
      label: 'LDAP',
      description: 'Use LDAP for user authentication'
    },
    {
      id: 'oidc',
      label: 'OIDC',
      description: 'Use OpenID Connect for user authentication'
    },
    {
      id: 'saml',
      label: 'SAML',
      description: 'Use SAML 2.0 for user authentication'
    }
  ]

  ngOnInit () {
    this.buildForm()

    this.form.valueChanges.subscribe(value => {
      this.usageType().patch(value)
    })
  }

  private buildForm () {
    const obj: BuildFormArgumentTyped<Form> = {
      keepOriginalVideo: null,
      p2p: null,
      transcription: null,
      authType: null
    }

    const {
      form,
      formErrors,
      validationMessages
    } = this.formReactiveService.buildForm<Form>(obj, this.usageType() as FormDefaultTyped<Form>)

    this.form = form
    this.formErrors = formErrors
    this.validationMessages = validationMessages
  }
}
