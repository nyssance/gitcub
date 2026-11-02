import { platform } from "@tauri-apps/plugin-os"
// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { addSafeDirectory, getRepositoryType } from "../lib/repository-access"
import type { Repository } from "../models/repository"
import { Button } from "./desktop/button"
import { LinkButton } from "./desktop/link-button"
import { Loading } from "./desktop/loading"
import { Ref } from "./desktop/ref"
import { Row } from "./desktop/row"
import type { RepositoryActionsDispatcher as Dispatcher } from "./repository-actions-contract"
import { UiView } from "./ui-view"

interface IMissingRepositoryProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
}

interface IMissingRepositoryState {
  readonly isPathUnsafe: boolean
  readonly unsafePath?: string
  readonly isTrustingPath: boolean
}

/** The view displayed when a repository is missing. */
export class MissingRepository extends React.Component<IMissingRepositoryProps, IMissingRepositoryState> {
  public constructor(props: IMissingRepositoryProps) {
    super(props)
    this.state = { isPathUnsafe: false, isTrustingPath: false }
  }

  private onTrustDirectory = async () => {
    this.setState({ isTrustingPath: true })
    const { unsafePath } = this.state
    const { repository } = this.props

    try {
      if (unsafePath) {
        await addSafeDirectory(unsafePath)
        const type = await getRepositoryType(repository.path)
        if (type.kind !== "unsafe") {
          this.checkAgain()
        }
      }
    } catch (error) {
      this.props.dispatcher.postError(error)
    } finally {
      this.setState({ isTrustingPath: false })
    }
  }

  public async componentDidMount() {
    this.updateUnsafePathState()
  }

  public async componentDidUpdate(prevProps: IMissingRepositoryProps) {
    if (prevProps.repository.path !== this.props.repository.path) {
      this.updateUnsafePathState()
    }
  }

  private updateUnsafePathState = async () => {
    const { path } = this.props.repository
    const type = await getRepositoryType(path)
    if (path === this.props.repository.path) {
      this.setState({
        isPathUnsafe: type.kind === "unsafe",
        unsafePath: type.kind === "unsafe" ? type.path : undefined
      })
    }
  }

  public render() {
    const buttons: React.JSX.Element[] = []
    const { isPathUnsafe, unsafePath } = this.state

    if (!isPathUnsafe) {
      buttons.push(
        <Button key="locate" onClick={this.locate} type="submit">
          Locate…
        </Button>
      )

      if (this.canCloneAgain()) {
        buttons.push(
          <Button key="clone-again" onClick={this.cloneAgain}>
            Clone Again
          </Button>
        )
      }
    } else {
      buttons.push(
        <Button key="trustDirectory" onClick={this.onTrustDirectory} type="submit" disabled={this.state.isTrustingPath}>
          {this.state.isTrustingPath && <Loading />}
          {platform() === "macos" ? "Trust Repository" : "Trust repository"}
        </Button>
      )
    }

    buttons.push(
      <Button key="remove" onClick={this.remove}>
        Remove
      </Button>
    )

    if (isPathUnsafe) {
      return (
        <UiView id="missing-repository-view">
          <div className="title-container">
            <div className="title">{this.props.repository.name} is potentially unsafe</div>
            <div className="details">
              <p>
                The Git repository at <Ref>{unsafePath}</Ref> appears to be owned by another user on your machine.
                Adding untrusted repositories may automatically execute files in the repository.
              </p>
              <p>
                If you trust the owner of the directory you can add an exception for this directory in order to
                continue.
              </p>
            </div>
          </div>

          <Row>{buttons}</Row>
        </UiView>
      )
    }

    return (
      <UiView id="missing-repository-view">
        <div className="title-container">
          <div className="title">Can't find "{this.props.repository.name}"</div>
          <div className="details">
            It was last seen at <span className="path">{this.props.repository.path}</span>.{" "}
            <LinkButton onClick={this.checkAgain}>Check&nbsp;again.</LinkButton>
          </div>
        </div>

        <Row>{buttons}</Row>
      </UiView>
    )
  }

  private canCloneAgain() {
    const gitHubRepository = this.props.repository.gitHubRepository
    // Preserve the original Desktop implementation.
    return gitHubRepository?.cloneURL
  }

  private checkAgain = () => {
    this.props.dispatcher.refreshRepository(this.props.repository)
  }

  private remove = () => {
    this.props.dispatcher.removeRepository(this.props.repository, false)
  }

  private locate = () => {
    this.props.dispatcher.relocateRepository(this.props.repository)
  }

  private cloneAgain = async () => {
    const gitHubRepository = this.props.repository.gitHubRepository
    if (!gitHubRepository) {
      return
    }

    const cloneURL = gitHubRepository.cloneURL
    if (!cloneURL) {
      return
    }

    try {
      await this.props.dispatcher.cloneAgain(cloneURL, this.props.repository.path)
    } catch (error) {
      this.props.dispatcher.postError(error)
    }
  }
}
