import { CdkStep, CdkStepper } from '@angular/cdk/stepper'
import { Component } from '@angular/core'
import { GlobalIconComponent } from '../../shared/shared-icons/global-icon.component'
import { NgIf, NgFor, NgClass, NgTemplateOutlet } from '@angular/common'

@Component({
  selector: 'my-register-stepper',
  templateUrl: './register-stepper.component.html',
  styleUrls: [ './register-stepper.component.scss' ],
  providers: [ { provide: CdkStepper, useExisting: RegisterStepperComponent } ],
  imports: [ NgIf, NgFor, NgClass, GlobalIconComponent, NgTemplateOutlet ]
})
export class RegisterStepperComponent extends CdkStepper {
  onClick (index: number): void {
    this.selectedIndex = index
  }

  isCompleted (step: CdkStep) {
    return step.completed
  }

  isAccessible (step: CdkStep) {
    return step.editable && step.completed
  }
}
