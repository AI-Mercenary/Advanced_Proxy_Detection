import React, { useEffect, useRef, useState, useCallback } from "react";
import * as faceapi from "face-api.js";

const App = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const detectionWindow = useRef([]);

  const referenceDescriptorsRef = useRef([]);
  const isMonitoringRef = useRef(false);
  const [showFaceOverlay, setShowFaceOverlay] = useState(false);
  const [isReferenceCaptured, setIsReferenceCaptured] = useState(false);
  const [proxyDetected, setProxyDetected] = useState(false);
  const [audioProxyDetected, setAudioProxyDetected] = useState(false);
  const [faceExpressions, setFaceExpressions] = useState({});
  const [statusMessage, setStatusMessage] = useState("Loading models...");
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [proxyEvents, setProxyEvents] = useState([]);
  const [objectDetected, setObjectDetected] = useState(null);
  const [detectionCount, setDetectionCount] = useState(0);
  const [headPosition, setHeadPosition] = useState({ pitch: 0, yaw: 0, roll: 0 });
  const [eyeGaze, setEyeGaze] = useState({ vertical: 'center', horizontal: 'center', downTime: 0 });
  const [headMovementTime, setHeadMovementTime] = useState({ direction: '', time: 0 });

  const TOLERANCE = 0.45;
  const NOISE_THRESHOLD_LOW = 0.2;
  const NOISE_THRESHOLD_MEDIUM = 0.4;
  const NOISE_THRESHOLD_HIGH = 0.6;
  const MULTIPLE_VOICES_THRESHOLD = 5;
  const HEAD_MOVEMENT_THRESHOLD = 10; // Lowered from 12 for sensitivity
  const EYE_DOWN_THRESHOLD = 5;
  const HEAD_MOVEMENT_DURATION_THRESHOLD = 3;
  const DETECTION_FRAME_THRESHOLD = 3;

  useEffect(() => {
    const loadModels = async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
        await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
        await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
        await faceapi.nets.faceExpressionNet.loadFromUri("/models");
        await faceapi.nets.ssdMobilenetv1.loadFromUri("/models");
        setStatusMessage("✅ Models loaded. Click 'Start Camera'.");
      } catch (error) {
        console.error("Error loading models:", error);
        setStatusMessage("❗ Error loading models. Please reload the page.");
      }
    };
    loadModels();
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          if (canvasRef.current && videoRef.current) {
            canvasRef.current.width = videoRef.current.videoWidth;
            canvasRef.current.height = videoRef.current.videoHeight;
            videoRef.current.style.width = '100%';
            videoRef.current.style.height = 'auto';
            videoRef.current.style.maxWidth = '640px';
          }
        };
      }

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const audioStream = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
      audioStream.connect(analyserRef.current);

      setIsCameraOn(true);
      setStatusMessage("📸 Camera started. Begin reference capture.");
    } catch (error) {
      console.error("Error accessing devices:", error);
      setStatusMessage("❗ Please allow camera and microphone permissions.");
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsCameraOn(false);
    setIsReferenceCaptured(false);
    referenceDescriptorsRef.current = [];
    setFaceExpressions({});
    setAudioProxyDetected(false);
    setStatusMessage("⏹️ Camera stopped.");
    setShowFaceOverlay(false);
    clearCanvas();
    detectionWindow.current = [];
  };

  const drawFaceOverlay = useCallback(() => {
    if (!canvasRef.current || !videoRef.current || !showFaceOverlay) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const faceWidth = canvas.width * 0.5;
    const faceHeight = canvas.height * 0.7;

    ctx.beginPath();
    ctx.ellipse(centerX, centerY, faceWidth / 2, faceHeight / 2, 0, 0, 2 * Math.PI);
    ctx.strokeStyle = "yellow";
    ctx.lineWidth = Math.max(4, canvas.width * 0.005);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 0, 0.2)";
    ctx.fill();

    ctx.fillStyle = "yellow";
    ctx.font = `${Math.max(24, canvas.width * 0.04)}px Arial`;
    ctx.textAlign = "center";
    ctx.fillText("Align your face within the oval", centerX, centerY - faceHeight / 2 - canvas.height * 0.1);
  }, [showFaceOverlay]);

  const captureReferencePhoto = async () => {
    if (!videoRef.current || !canvasRef.current) {
      setStatusMessage("❗ Camera not ready. Try again.");
      return;
    }

    setShowFaceOverlay(true);
    drawFaceOverlay();

    try {
      const detections = await faceapi
        .detectAllFaces(videoRef.current, new faceapi.SsdMobilenetv1Options())
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withFaceExpressions();

      setShowFaceOverlay(false);
      clearCanvas();

      if (detections.length === 1) {
        referenceDescriptorsRef.current = [detections[0].descriptor];
        setIsReferenceCaptured(true);
        setStatusMessage("✅ Reference captured! Click 'Start Monitoring'.");
      } else {
        setStatusMessage(`❗ Failed to capture. ${detections.length === 0 ? "No face detected" : "Multiple faces detected"}. Try again.`);
      }
    } catch (error) {
      console.error("Capture error:", error);
      setShowFaceOverlay(false);
      clearCanvas();
      setStatusMessage("❗ Capture error. Please try again.");
    }
  };

  const drawFaceTracking = useCallback((detections) => {
    if (!canvasRef.current || !videoRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    detections.forEach((det) => {
      const { x, y, width, height } = det.detection.box;
      const headPose = calculateHeadPose(det.landmarks);
      const gaze = detectEyeGaze(det.landmarks);

      let headDirection = '';
      if (headPose.yaw > HEAD_MOVEMENT_THRESHOLD) headDirection = 'right';
      else if (headPose.yaw < -HEAD_MOVEMENT_THRESHOLD) headDirection = 'left';
      else if (headPose.pitch > HEAD_MOVEMENT_THRESHOLD) headDirection = 'down';
      else if (headPose.pitch < -HEAD_MOVEMENT_THRESHOLD) headDirection = 'up';

      ctx.strokeStyle = headDirection ? "red" : "green";
      ctx.lineWidth = Math.max(3, canvas.width * 0.005);
      ctx.strokeRect(x, y, width, height);

      if (headDirection) {
        ctx.fillStyle = "red";
        ctx.font = `${Math.max(20, canvas.width * 0.03)}px Arial`;
        ctx.fillText(`Head Moving ${headDirection}`, x, y - canvas.height * 0.05);
      }

      if (gaze.vertical !== 'center' || gaze.horizontal !== 'center') {
        ctx.fillStyle = "red";
        ctx.beginPath();
        ctx.arc(x + width / 2, y + height / 2, canvas.width * 0.015, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(`Eye Gaze: ${gaze.vertical}/${gaze.horizontal}`, x, y - canvas.height * 0.02);
      }

      ctx.font = `${Math.max(16, canvas.width * 0.025)}px Arial`;
      ctx.fillStyle = ctx.strokeStyle;
      const expression = getMostLikelyExpression(det.expressions);
      ctx.fillText(`${expression} (${(det.expressions[expression] * 100).toFixed(1)}%)`, x, y + height + canvas.height * 0.04);
    });
  }, []);

  const getMostLikelyExpression = (expressions) => {
    return Object.entries(expressions).reduce(
      (acc, [expr, value]) => (value > acc.value ? { expression: expr, value } : acc),
      { expression: "", value: 0 }
    ).expression;
  };

  const calculateHeadPose = (landmarks) => {
    const noseTip = landmarks.getNose()[4];
    const chin = landmarks.getJawOutline()[8];
    const leftEyeCorner = landmarks.getLeftEye()[0];
    const rightEyeCorner = landmarks.getRightEye()[3];
    const forehead = landmarks.getJawOutline()[0];

    const eyeMidpoint = {
      x: (leftEyeCorner.x + rightEyeCorner.x) / 2,
      y: (leftEyeCorner.y + rightEyeCorner.y) / 2,
    };

    const yaw = Math.atan2(noseTip.x - eyeMidpoint.x, 80) * (180 / Math.PI);
    const faceHeight = chin.y - forehead.y;
    const noseRelative = (noseTip.y - forehead.y) / faceHeight;
    const pitch = (noseRelative - 0.5) * 100;
    const eyeDeltaY = rightEyeCorner.y - leftEyeCorner.y;
    const eyeDeltaX = rightEyeCorner.x - leftEyeCorner.x;
    const roll = Math.atan2(eyeDeltaY, eyeDeltaX) * (180 / Math.PI);

    console.log("Head Pose Debug:", {
      noseTipX: noseTip.x,
      eyeMidpointX: eyeMidpoint.x,
      yaw: yaw.toFixed(2),
      pitch: pitch.toFixed(2),
      roll: roll.toFixed(2),
    });

    return { pitch, yaw, roll };
  };

  const detectEyeGaze = (landmarks) => {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();

    const leftCenter = {
      x: leftEye.reduce((sum, p) => sum + p.x, 0) / 6,
      y: leftEye.reduce((sum, p) => sum + p.y, 0) / 6,
    };
    const rightCenter = {
      x: rightEye.reduce((sum, p) => sum + p.x, 0) / 6,
      y: rightEye.reduce((sum, p) => sum + p.y, 0) / 6,
    };

    const noseTip = landmarks.getNose()[4];
    const eyeDistance = rightCenter.x - leftCenter.x;

    const verticalDiff = ((leftCenter.y + rightCenter.y) / 2 - noseTip.y) / (eyeDistance * 0.35);
    const vertical = verticalDiff > 0.05 ? 'down' : verticalDiff < -0.05 ? 'up' : 'center';

    const leftPupil = (leftCenter.x - leftEye[0].x) / (eyeDistance * 0.1);
    const rightPupil = (rightEye[3].x - rightCenter.x) / (eyeDistance * 0.1);
    const horizontalAvg = (leftPupil + rightPupil) / 2;
    const horizontal = horizontalAvg > 0.1 ? 'right' : horizontalAvg < -0.1 ? 'left' : 'center';

    console.log("Eye Gaze Debug:", {
      verticalDiff: verticalDiff.toFixed(4),
      vertical,
      horizontal,
    });

    return { vertical, horizontal };
  };

  const startAudioDetection = useCallback(() => {
    const detectAudio = () => {
      if (!isMonitoringRef.current || !analyserRef.current) return;

      const bufferLength = analyserRef.current.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyserRef.current.getByteFrequencyData(dataArray);

      const volume = Math.sqrt(dataArray.reduce((sum, val) => sum + val ** 2, 0) / bufferLength) / 255;
      const peakCount = dataArray.filter((val) => val > 150).length;

      let audioLevel = "low";
      if (volume > NOISE_THRESHOLD_HIGH) audioLevel = "high";
      else if (volume > NOISE_THRESHOLD_MEDIUM) audioLevel = "medium";

      const isMultipleVoices = peakCount > MULTIPLE_VOICES_THRESHOLD;

      setAudioProxyDetected(isMultipleVoices || audioLevel !== "low");

      if (isMultipleVoices) {
        setStatusMessage("🚨 Multiple Voices Detected!");
        setProxyEvents((prev) => [
          ...prev,
          { type: "Multiple Voices", time: new Date().toLocaleTimeString() },
        ]);
      } else if (audioLevel !== "low") {
        setStatusMessage(`🚨 Audio Level: ${audioLevel.toUpperCase()}!`);
        setProxyEvents((prev) => [
          ...prev,
          { type: `Audio Level: ${audioLevel.toUpperCase()}`, time: new Date().toLocaleTimeString() },
        ]);
      }

      if (isMonitoringRef.current) {
        requestAnimationFrame(detectAudio);
      }
    };

    detectAudio();
  }, []);

  const startFaceDetection = useCallback(async () => {
    const detectFaces = async () => {
      if (!videoRef.current || !isMonitoringRef.current) return;

      try {
        const detections = await faceapi
          .detectAllFaces(videoRef.current, new faceapi.SsdMobilenetv1Options())
          .withFaceLandmarks()
          .withFaceDescriptors()
          .withFaceExpressions();

        console.log("Face Detections:", { count: detections.length });

        if (detections.length > 0) {
          drawFaceTracking(detections);

          let newExpressions = {};
          let isProxyFound = detections.length > 1;
          let headMovementMessage = "";

          detections.forEach((det, index) => {
            newExpressions[`Face ${index + 1}`] = getMostLikelyExpression(det.expressions);

            const headPose = calculateHeadPose(det.landmarks);
            setHeadPosition(headPose);

            console.log("Head Pose:", {
              yaw: headPose.yaw.toFixed(2),
              pitch: headPose.pitch.toFixed(2),
              roll: headPose.roll.toFixed(2),
            });

            const gaze = detectEyeGaze(det.landmarks);

            let headDirection = '';
            if (headPose.yaw > HEAD_MOVEMENT_THRESHOLD) headDirection = 'right';
            else if (headPose.yaw < -HEAD_MOVEMENT_THRESHOLD) headDirection = 'left';
            else if (headPose.pitch > HEAD_MOVEMENT_THRESHOLD) headDirection = 'down';
            else if (headPose.pitch < -HEAD_MOVEMENT_THRESHOLD) headDirection = 'up';

            console.log("Head Direction:", headDirection);

            if (headDirection) {
              headMovementMessage = `🚨 Head Moving ${headDirection.toUpperCase()}!`;
            }

            setHeadMovementTime((prev) => {
              if (headDirection && headDirection === prev.direction) {
                const newTime = prev.time + 1 / 60;
                if (newTime > HEAD_MOVEMENT_DURATION_THRESHOLD) {
                  setProxyEvents((prevEvents) => [
                    ...prevEvents,
                    { type: `Head Moving ${headDirection}`, time: new Date().toLocaleTimeString() },
                  ]);
                }
                return { direction: headDirection, time: newTime };
              }
              return headDirection ? { direction: headDirection, time: 0 } : { direction: '', time: 0 };
            });

            setEyeGaze((prev) => {
              if (gaze.vertical === 'down') {
                const newTime = prev.downTime + 1 / 60;
                console.log("Eye Down Time:", newTime.toFixed(2));
                if (newTime > EYE_DOWN_THRESHOLD) {
                  setProxyEvents((prevEvents) => [
                    ...prevEvents,
                    { type: "Eye Gaze Down", time: new Date().toLocaleTimeString() },
                  ]);
                }
                return { ...gaze, downTime: newTime };
              }
              return { ...gaze, downTime: 0 };
            });
          });

          setFaceExpressions(newExpressions);
          setProxyDetected(isProxyFound);

          // Set status message: prioritize multiple faces, then head movement
          if (isProxyFound) {
            setStatusMessage("🚨 Unauthorized second face detected!");
          } else if (headMovementMessage) {
            setStatusMessage(headMovementMessage);
          } else {
            setStatusMessage("");
          }
        } else {
          clearCanvas();
          setFaceExpressions({});
          setHeadPosition({ pitch: 0, yaw: 0, roll: 0 });
          setEyeGaze({ vertical: 'center', horizontal: 'center', downTime: 0 });
          setHeadMovementTime({ direction: '', time: 0 });
          setStatusMessage("");
        }
      } catch (error) {
        console.error("Error during face detection:", error);
        setStatusMessage("");
      }

      if (isMonitoringRef.current) {
        requestAnimationFrame(detectFaces);
      }
    };

    detectFaces();
  }, [drawFaceTracking, isReferenceCaptured]);

  const drawMobileOverlay = (edgePixels, uniformPixels) => {
    if (!canvasRef.current || !videoRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    // Draw edge pixels (red rectangles)
    edgePixels.forEach(({ x, y }) => {
      ctx.strokeStyle = "red";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, 5, 5);
    });

    // Draw uniform cluster pixels (blue rectangles)
    uniformPixels.forEach(({ x, y }) => {
      ctx.strokeStyle = "blue";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, 5, 5);
    });
  };

  const detectObject = async () => {
    if (!videoRef.current || !isMonitoringRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = videoRef.current;

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    let rectCount = 0;
    let edgeCount = 0;
    let highContrastCount = 0;
    let uniformClusterCount = 0;
    let consecutiveUniform = 0;
    const edgePixels = [];
    const uniformPixels = [];

    const faceDetections = await faceapi.detectAllFaces(videoRef.current, new faceapi.SsdMobilenetv1Options());
    const faceCount = faceDetections.length;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const x = (i / 4) % canvas.width;
      const y = Math.floor((i / 4) / canvas.width);

      if (i % (canvas.width * 4) > 4 && i < data.length - canvas.width * 4) {
        const horizontalDiff =
          Math.abs(r - data[i - 4]) +
          Math.abs(g - data[i - 4 + 1]) +
          Math.abs(b - data[i - 4 + 2]);

        const verticalDiff =
          i >= canvas.width * 4
            ? Math.abs(r - data[i - canvas.width * 4]) +
              Math.abs(g - data[i - canvas.width * 4 + 1]) +
              Math.abs(b - data[i - canvas.width * 4 + 2])
            : 0;

        if (horizontalDiff > 80 || verticalDiff > 80) {
          edgeCount++;
          edgePixels.push({ x, y });
          consecutiveUniform = 0;
        } else if (horizontalDiff < 20) {
          consecutiveUniform++;
          if (consecutiveUniform >= 4) {
            uniformClusterCount++;
            uniformPixels.push({ x, y });
            consecutiveUniform = 0;
          }
        } else {
          // Don't reset consecutiveUniform for non-edge, non-uniform pixels
        }
      }

      if (Math.max(r, g, b) - Math.min(r, g, b) > 100) highContrastCount++;
    }

    rectCount = uniformClusterCount;

    const rectRatio = rectCount / (canvas.width * canvas.height);
    const edgeRatio = edgeCount / (canvas.width * canvas.height);
    const contrastRatio = highContrastCount / (canvas.width * canvas.height);

    console.log("Mobile Detection:", {
      rectCount,
      edgeCount,
      highContrastCount,
      uniformClusterCount,
      edgePixels: edgePixels.length,
      uniformPixels: uniformPixels.length,
      rectRatio: rectRatio.toFixed(4),
      edgeRatio: edgeRatio.toFixed(4),
      contrastRatio: contrastRatio.toFixed(4),
      faceCount,
    });

    let faceCoverage = 1;
    if (faceCount >= 1 && faceDetections.length > 0 && faceDetections[0].detection) {
      const faceArea = faceDetections[0].detection.box;
      faceCoverage = (faceArea.width * faceArea.height) / (canvas.width * canvas.height);
      console.log("Face Coverage:", faceCoverage.toFixed(4));
    }

    const isMobileDetected =
      rectRatio > 0.055 &&
      edgeRatio > 0.07 &&
      contrastRatio > 0.08 &&
      faceCoverage < 0.45;

    detectionWindow.current.push(isMobileDetected);
    if (detectionWindow.current.length > DETECTION_FRAME_THRESHOLD) {
      detectionWindow.current.shift();
    }

    if (detectionWindow.current.length === DETECTION_FRAME_THRESHOLD && detectionWindow.current.every((val) => val)) {
      setObjectDetected("Mobile device detected");
      setDetectionCount((prev) => prev + 1);
      setProxyEvents((prev) => [
        ...prev,
        { type: "Mobile Device Detected", time: new Date().toLocaleTimeString() },
      ]);
      setStatusMessage("🚨 Mobile device detected!");
      drawMobileOverlay(edgePixels, uniformPixels);
    } else {
      setObjectDetected(null);
      clearCanvas();
    }
  };

  const startMonitoring = () => {
    if (!isReferenceCaptured) {
      setStatusMessage("❗ Please capture the reference photo first.");
      return;
    }
    isMonitoringRef.current = true;
    setProxyDetected(false);
    setAudioProxyDetected(false);
    setFaceExpressions({});
    setStatusMessage("");
    startFaceDetection();
    startAudioDetection();
    detectionWindow.current = [];
  };

  const stopMonitoring = () => {
    isMonitoringRef.current = false;
    clearCanvas();
    setFaceExpressions({});
    setProxyDetected(false);
    setAudioProxyDetected(false);
    setStatusMessage("⏹️ Monitoring stopped.");
    detectionWindow.current = [];
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  useEffect(() => {
    const interval = setInterval(() => {
      if (isMonitoringRef.current) {
        detectObject();
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ textAlign: "center", marginTop: "20px", fontFamily: "Arial, sans-serif", padding: "0 10px" }}>
      <h1>Advanced Proxy Detection System</h1>
      <div style={{ position: "relative", display: "inline-block", width: "100%", maxWidth: "640px" }}>
        <video ref={videoRef} autoPlay playsInline style={{ width: "100%", height: "auto" }}></video>
        <canvas ref={canvasRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }} />
      </div>

      <div style={{ marginTop: "10px" }}>
        {!isCameraOn ? (
          <button onClick={startCamera} style={buttonStyle}>
            📸 Start Camera
          </button>
        ) : (
          <>
            {!isReferenceCaptured && (
              <button onClick={captureReferencePhoto} style={buttonStyle}>
                📷 Capture Reference
              </button>
            )}
            <button onClick={startMonitoring} style={buttonStyle}>
              ▶️ Start Monitoring
            </button>
            <button onClick={stopMonitoring} style={buttonStyle}>
              ⏹️ Stop Monitoring
            </button>
            <button onClick={stopCamera} style={buttonStyle}>
              🚫 Stop Camera
            </button>
          </>
        )}
      </div>

      <div>
        <h3>Detected Facial Expressions:</h3>
        {Object.entries(faceExpressions).map(([face, expr], index) => (
          <p key={index}>
            {face}: <strong>{expr}</strong>
          </p>
        ))}
      </div>

      {proxyDetected && (
        <div style={{ color: "red", fontWeight: "bold", marginTop: "10px" }}>
          🚨 Unauthorized second face detected!
        </div>
      )}

      {audioProxyDetected && (
        <div style={{ color: "red", fontWeight: "bold", marginTop: "10px" }}>
          🚨 Proxy in Audio! Noise or Multiple Voices Detected!
        </div>
      )}

      {statusMessage && (
        <div
          style={{
            marginTop: "20px",
            fontWeight: "bold",
            color: proxyDetected || audioProxyDetected || objectDetected ? "red" : "green",
          }}
        >
          {statusMessage}
        </div>
      )}

      <div style={{ marginTop: "20px" }}>
        <h3>Proxy Detection Events:</h3>
        <ul>
          {proxyEvents.map((event, index) => (
            <li key={index}>
              {event.type} detected at {event.time}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ marginTop: "20px" }}>
        <h3>Detection Summary:</h3>
        <p>Total Proxy Detected: <strong>{detectionCount}</strong></p>
        <p>Object Status: <strong>{objectDetected || "None"}</strong></p>
      </div>

      <div style={{ marginTop: "20px" }}>
        <h3>Head Position:</h3>
        <p>Pitch (Up/Down): {headPosition.pitch.toFixed(2)}°</p>
        <p>Yaw (Left/Right): {headPosition.yaw.toFixed(2)}°</p>
        <p>Roll (Tilt): {headPosition.roll.toFixed(2)}°</p>
      </div>

      <div style={{ marginTop: "20px" }}>
        <h3>Eye Gaze:</h3>
        <p>Vertical: {eyeGaze.vertical}</p>
        <p>Horizontal: {eyeGaze.horizontal}</p>
        {eyeGaze.vertical === 'down' && <p>Time Looking Down: {eyeGaze.downTime.toFixed(2)}s</p>}
      </div>

      <div style={{ marginTop: "20px" }}>
        <h3>Head Movement:</h3>
        <p>Direction: {headMovementTime.direction || 'centered'}</p>
        {headMovementTime.direction && <p>Duration: {headMovementTime.time.toFixed(2)}s</p>}
      </div>
    </div>
  );
};

const buttonStyle = {
  margin: "5px",
  padding: "10px 15px",
  border: "none",
  borderRadius: "8px",
  backgroundColor: "#4CAF50",
  color: "#fff",
  fontSize: "16px",
  cursor: "pointer",
  transition: "background-color 0.3s",
};

export default App;