// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

const CodeImage = "/desktop/code.svg"
const TeamDiscussionImage = "/desktop/github-for-teams.svg"
const CloudServerImage = "/desktop/github-for-business.svg"

export class TutorialWelcome extends React.Component {
  public render() {
    return (
      <div id="tutorial-welcome">
        <div className="header">
          <h1>Welcome to GitHub Desktop</h1>
          <p>Use this tutorial to get comfortable with Git, GitHub, and GitHub Desktop.</p>
        </div>
        <ul className="definitions">
          <li>
            <img src={CodeImage} alt="Html syntax icon" />
            <p>
              <strong>Git</strong> is the version control system.
            </p>
          </li>
          <li>
            <img src={TeamDiscussionImage} alt="People with discussion bubbles overhead" />
            <p>
              <strong>GitHub</strong> is where you store your code and collaborate with others.
            </p>
          </li>
          <li>
            <img src={CloudServerImage} alt="Server stack with cloud" />
            <p>
              <strong>GitHub Desktop</strong> helps you work with GitHub locally.
            </p>
          </li>
        </ul>
      </div>
    )
  }
}
