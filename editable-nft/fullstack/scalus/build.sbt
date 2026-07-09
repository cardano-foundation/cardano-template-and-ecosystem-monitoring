ThisBuild / scalaVersion := "3.3.8"
ThisBuild / organization := "org.scalus.examples"
ThisBuild / version      := "0.1.0-SNAPSHOT"


val scalusVersion = "0.18.2"

lazy val root = (project in file("."))
    .enablePlugins(ScalusSbtPlugin)
    .settings(
        name := "editable-nft",
        scalacOptions ++= Seq("-deprecation", "-feature"),
        libraryDependencies ++= Seq(
            "org.scalus" %% "scalus"                % scalusVersion,
            "org.scalus" %% "scalus-cardano-ledger" % scalusVersion,
            "org.scalus" %% "scalus-testkit"         % scalusVersion % Test,
            "org.scalatest" %% "scalatest"           % "3.2.20"     % Test
        ),
        addCompilerPlugin(
            ("org.scalus" %% "scalus-plugin" % scalusVersion).cross(CrossVersion.full)
        ),
        Compile / sources := {
            val base = baseDirectory.value
            val testDir = base / "test"
            val targetDir = target.value
            (base ** "*.scala").get()
                .filterNot(f => f.relativeTo(testDir).isDefined)
                .filterNot(f => f.relativeTo(targetDir).isDefined)
                .toSeq
        },
        Test / sources := ((baseDirectory.value / "test") ** "*.scala")
            .get()
            .toSeq,
    )
